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

## Multi-dataset tune index (August 2026 — v3.11.0)

The index is no longer one blob. It is published and stored as **one file per
source** — `thesession` (34.8 MB), `folkwiki` (7.3 MB), `norbeck` (3.1 MB) —
plus a `datasets.json` manifest, and the user chooses which are downloaded,
stored offline and searched (Settings → Offline Tune Database). Default is
`['thesession', 'folkwiki']`, i.e. exactly the old behaviour; norbeck is opt-in.

Everything in "Offline architecture" below still holds; it is now applied **per
dataset**. The three invariants the tests pin:

> **P1 — per dataset.** If a usable offline copy of dataset D existed before an
> operation, one exists after it, wherever the operation died and whatever the
> operation was *about*. An operation concerning E must not touch D at all.
>
> **P2 — coverage.** `indexUsable` is false only when *every* selected dataset
> genuinely has no usable copy, or the selection is empty.
>
> **P3 — migration.** The pre-multi-dataset merged blob is present until every
> dataset it covers has a committed per-dataset copy that has loaded into WASM,
> and absent afterwards. There is no state in which both are missing.

**The unscoped delete is the bug class this introduces.** A corrupt folkwiki
must never cost the user their thesession copy. Every delete in
`tuneIndexStore.js` is scoped to one id, and the fault-injection walk in
`tune-index-cache.test.mjs` seeds all three datasets and asserts all three
survive an interruption at every storage operation of an update to *one*.

### Datasets the app does not host

**Not every dataset FolkFriend can search is one it may distribute.** Norbeck's
terms forbid making the ABC files available for download on a web page, so that
dataset is built by the data repo but never published: it is absent from
`datasets.json`, absent from `public/`, and `assemble_datasets.py` writes a
`PUBLISHED_FILES.txt` that `build.sh` obeys so it cannot be deployed by accident.

The way in is **Settings → "Add a database"**, which takes either a file the
user picks or a URL they supply (`worker.addUserDataset`). Same order as every
other install — parse → `indexPayloadProblem` → load into WASM → write — because
it replaces a copy just as irrecoverably. A URL is fetched **inside the worker**
so a 3 MB body never crosses the Comlink boundary.

Three things this needs that a published dataset does not:

- **The file must be self-describing.** There is no `datasets.json` entry to say
  what it is, so `assemble_datasets.py` stamps `id`, `label`, `description`, `v`
  and `date` into every dataset file. An import with no usable `id` is refused —
  there would be nothing to store it under and nothing to call it.
- **Its manifest records provenance** (`origin: 'user'`, `label`, and the `url`
  if there was one). Without it the next update check would call the dataset
  "not published" — permanently, and unactionably — and its name would revert to
  its raw id. `_installDatasets` carries these through a refresh for the same
  reason, and takes the version from the *fetched file* rather than the stale
  local manifest, because the file is the thing that describes itself.
- **A cross-origin URL usually will not work**, and the browser reports it as a
  bare "Failed to fetch" that is indistinguishable from being offline. Most
  hosts send no `Access-Control-Allow-Origin`. `fetchUserDatasetText` translates
  that into an explanation naming CORS and pointing at the file route, which
  always works. This will otherwise be the single most common confusion with the
  feature.

**An import is untrusted input, and is guarded accordingly:**

- **It runs under the install lock.** Without it an import merges from its own
  view of what is loaded and can interleave with a startup update or a manual
  refresh, leaving WASM holding one operation's merge while `loadedDatasets`
  claims both.
- **It cannot impersonate a published dataset.** Storing under `thesession`
  would put an unvetted file behind a name the app manages, to be overwritten —
  or not — by the next CDN update depending on ordering.
- **It cannot reuse another dataset's IDs — setting *or* tune.** `mergeIndexParts`
  counts the two separately, because they fail differently. A setting clash
  hides one setting; a **tune** clash is worse — the later dataset's aliases
  overwrite the earlier tune's NAME, its `datasetByTune` entry relabels the
  source, and Rust groups both datasets' settings under one tune. Counting only
  setting ids let a dataset with fresh setting ids but recycled tune ids pass
  every check. Since favourites are keyed by setting id alone, the visible
  symptom either way is a favourite opening the wrong tune.

  For a CDN file a collision stays a warning — denying the user their whole
  index over a data-repo bug is not proportionate. For an import it is a
  refusal.

  **The invariant is enforced at EVERY MERGE, not at the import site.**
  `vetUserParts` runs inside `loadMergedIndex` and drops any user-origin part
  that would collide with anything else in that merge, whatever triggered it.
  Checking only where an import is added left the collision reachable from the
  other end: deselect thesession (keeping its copy and its favourites), import
  something reusing its IDs — accepted, because thesession is not in the merge
  — then re-enable thesession. That merge comes from the selection change, so
  nothing re-checked it.

  The offending part is **dropped, not the whole merge refused**: at startup a
  refusal would leave the user with no index at all, which is worse than
  leaving out one imported dataset. Published data always wins; among imports,
  first in selection order wins.

  **Every path that merges must carry `merged.rejected` into its bookkeeping**
  — cache, selection AND install. The install path missed it at first, so a
  download that displaced an already-loaded import left `_afterInstall`
  starting from the previous `loadedDatasets` and still reporting the import as
  loaded, with no reason given, while its tunes had silently stopped being
  findable. A dropped part is excluded from `datasetsLoaded`, appears in
  `datasetsMissing`, and gets its reason in `datasetErrors`, because the status
  must never claim more than WASM holds. Startup analytics reports the vetted
  set for the same reason.

  **An import is additionally vetted against every STORED dataset**, not just
  the selected ones — a deselected dataset still has favourites pointing into
  it, so its IDs are still spoken for. That is what turns a silent
  refuses-to-load-later into an error at the moment of import.

  **The candidate is vetted by `collisionsForPart`, not by the merge's own
  counts.** `mergeIndexParts` exempts the legacy migration base from its
  totals, because the base holds older copies of the very datasets being
  migrated and overlap there is expected. That exemption is right for a
  published dataset replacing itself and wrong for an import — and since the
  base is processed *last*, a candidate processed before it never saw the
  overlap either. So an import made while migration is deferred (auto-update
  off, or a migration that failed) could shadow thesession or folkwiki IDs that
  currently live only inside the merged blob. `collisionsForPart` compares the
  candidate against every other part, base included, independently of merge
  order.
- **Both checks run on EVERY fetch, not just the first.** The remembered URL is
  not under our control, so a payload that was clean when it was added can start
  colliding later; the refresh path used to merely log it and persist anyway.
- **A refresh cannot change what the dataset IS.** Identity is checked by exact
  equality (`servedId === entry.id`), not "different if it says anything". An
  imported dataset is required to be self-describing, so a payload with no `id`
  is not a lenient case — it is a file that cannot prove it is still the same
  collection.
- **A rejected payload never reaches WASM.** `loadMergedIndex` takes a
  `validate` callback that runs on the merged result *before* the load, so a
  refusal costs nothing and there is nothing to undo. It previously loaded
  first and reloaded the old selection on rejection, which left a window where
  the app was searching data it had just refused to save — and depended on the
  undo itself not failing. The tests assert `loadCalls` does not move.
- **`source_url` is scheme-checked** (`safeSourceUrl`) and escaped where it is
  interpolated. It reaches `href` attributes and the exported favourites HTML,
  which people share — `javascript:` and `data:` are both markup-injection
  routes, and the export previously interpolated it unescaped.

**`KNOWN_DATASETS` in `store.js` is the list the app OFFERS, and Norbeck is
deliberately not in it.** Leaving it there rendered a built-in checkbox for a
dataset nothing serves — ticking it would simply fail. It reaches the app
through "Add a database" and appears in the list once stored. Its name still
lives in `DATASET_LABELS` (`source.mjs`), which is a different question: the app
does not offer to fetch it, but it must still be named properly once someone
imports it.

`KNOWN_DATASETS` is not the list of ids the app *understands* — an imported
dataset can have any id, which is why `sanitiseDatasets` keeps unknown ids and
`datasetForTuneID` passes an unrecognised label through untouched.

**The importable file is `build/data/norbeck.json` from the data repo**, i.e.
the one `assemble_datasets.py` has stamped — not the raw output of
`build_norbeck_data.py`, which has no `id` and is refused on import.

### Partial success is READY

With two of three selected datasets loaded, queries work and return real tunes,
so the app is `READY`. Reporting `UNAVAILABLE` would make
`backend.indexReady()` resolve false and push Tune and Search into
favourites-only mode — strictly worse than searching the 62k tunes the user
does have, and it would take the whole app down whenever one small file 404s.
Same usability-vs-status distinction the state machine already drew for
background updates.

There is deliberately **no `'partial'` status**: a dozen `status === 'ready'`
comparisons across the app would silently stop matching. The detail carries
`datasetsLoaded` / `datasetsMissing` / `datasetErrors`, and **Search.vue
surfaces a note when something is missing** — that part is required work, not
polish. A user whose norbeck download quietly failed would otherwise search a
Swedish tune, get nothing, and conclude FolkFriend does not have it. This
codebase has three separate scars from failures that were invisible for a
session.

One new terminal reason, `'no-datasets-selected'`. It is a legitimate choice,
not a failure, so `backend`'s `'online'` retry handler skips it — otherwise
every network blip re-runs a setup that cannot succeed.

### Rules the tests pin, each verified by reinstating the bug

1. **A per-dataset write does NOT reclaim the merged blob.** This *inverts* the
   old schema-2 rule. The merged blob covers two datasets and one write covers
   one; dropping it on the first write deletes data nothing has replaced.
   `clearSupersededMergedCopies` does it, and only once re-reading disk confirms
   every covered dataset is committed and loaded.
2. **A toggle never deletes a payload.** Worse than deleting on failure: the
   user may flip it back in thirty seconds and now needs 35 MB of signal they
   may not have. Deselected copies are kept and shown as "saved but not in use";
   `removeDataset`, behind a confirm, is the only path that deletes one.
3. **Turning a dataset back on needs no network** when its copy is on disk.
4. **Turning off the last one unloads** rather than loading an empty index —
   `indexPayloadProblem` would reject one anyway, and Rust would happily return
   nothing with no explanation.
5. **A half-finished migration never reduces what is searchable.** The merged
   blob is passed to `mergeIndexParts` as a **base part** (`id: null`) that
   fills gaps and never overwrites a dataset file. Without it, the first
   per-dataset load during a migration replaced WASM with only that dataset,
   so a later failure silently dropped every un-migrated source from search for
   the rest of the session — while `_afterInstall` still reported them loaded,
   having inherited their `source: 'merged'` entries. Nothing was lost on disk;
   the app just quietly stopped finding half its tunes and said it was fine.
   `loadedDatasets` now reports only what is genuinely in WASM.
6. **Only datasets known to load are merged back in.** `_partsToKeep` reads
   `loadedDatasets` ∪ just-installed, **not** everything on disk. Merging back a
   cached copy the Rust side refuses (a real schema change) poisons every
   subsequent install, so the incompatible copy can never be replaced and the
   app stays unavailable forever. Keeping such a copy is right; feeding it back
   into WASM is not. *Found by a test, not by reasoning.*
7. **Joining an in-flight install is narrowed to a subset test.** Joining
   unconditionally is wrong once requests can be disjoint: an install of
   `['thesession']` would hand a caller asking for `['norbeck']` a result with
   no norbeck in it. Anything not covered is serialised behind it on
   `_installChain`. A plain `while (inFlight) await inFlight` is also wrong —
   two waiters both wake, both see null, both start.
8. **A part contributing zero new setting IDs is a failed dataset.** If
   `datasets.json` points two entries at the same file, both documents pass
   `indexPayloadProblem` perfectly and the failure would present as "folkwiki is
   missing" with no error anywhere.
9. **Progress is aggregated and clamped.** `received` counts decoded bytes while
   `size` from `datasets.json` is the uncompressed length; they agree in
   production but a stale manifest must not push the bar past 100%. Preferring
   `size` over `Content-Length` also fixes a pre-existing bug — Firebase gzips
   JSON, so `Content-Length` was the compressed length and the bar always
   overshot, saved only by `Math.min`.

### Migration from the merged blob

An upgrading install loads the schema-2 blob at startup, so the app is READY
immediately and nothing changes for the user, then installs the per-dataset
files in the background (largest first, to keep the window where it searches
fewer tunes short), and deletes the blob only once disk confirms full coverage.

**Gated on `autoUpdateTuneData`.** A user who turned that off has explicitly
asked not to be given downloads they did not request, and this is ~42 MB for
zero new content. They keep the merged blob and migrate on their next explicit
tap in Settings.

> ⚠️ **Transient quota doubling.** Holding both copies means ~84 MB during
> migration — the exact condition the plane incident is blamed on. On a device
> near quota this fails with `QuotaExceededError` *forever*, and the user sits
> on the merged blob indefinitely. **A "replace the combined copy" action that
> deletes the blob first — offered only after repeated failures and only while
> online — is not built yet.** Without it, "never leave a user with nothing"
> quietly becomes "never let some users migrate".

### Source labelling replaced the ID-range hack

`source.mjs` used to decide the source with `tuneID < 1000000 ? thesession :
folkwiki`. That cannot survive a third source: folkwiki's hash-derived IDs run
to ~1.68e9, so there is no clean range to add.

The worker now labels every tune with the dataset file it came from
(`datasetByTune`, built by `mergeIndexParts` and **rebuilt wholesale on every
merge, never incrementally** — the same hazard class as `abcStringBySetting`).
Every `source.mjs` function takes an optional explicit `dataset` and prefers it.

The ID-range rule survives as the fallback for **any tune with no label** — a
legacy merged blob, or a favourite saved before labelling existed. It covers all
three sources.

It originally excluded Norbeck, on the argument that a merged blob contains
nothing else by construction so a third range would be a place to keep in sync
for a case that could not arise. **That argument was wrong**: a favourite is a
self-contained snapshot, so one saved without a label reaches the fallback
carrying a Norbeck tune id and was reported as folkwiki. The ranges here must
match the ID bases in the data repo's builders.

An explicit label **always wins, including one this build does not recognise**.
Passing an unknown id through rather than relabelling it is what makes a fourth
dataset addable from the data repo alone; `sanitiseDatasets` keeps unknown ids
in the saved selection for the same reason. Such a dataset appears under its raw
id with no description, and must carry `source_url` — nothing can derive a link
for it — and `tuneSourceUrl` returns `''` rather than guessing a folkwiki page.

`aiSummary.js` calls `isThesessionTuneID` without a label on purpose: it only
asks "does this tune have a thesession.org page", and the fallback answers that
correctly for every source.

### The service worker guard that this broke

`maximumFileSizeToCacheInBytes: 20 MB` used to double as the guard keeping the
tune index out of the precache. That reasoning was never "20 MB is a sensible
cap" — it was **"smaller than the smallest dataset"** — and the smallest is now
~3 MB, well under the limit. A local build leaves the dataset files in
`public/res/`, so `norbeck.json` would have been **silently precached**,
reintroducing exactly the double-storage failure `sw-cleanup.js` exists to undo.

They are excluded **by name** in `vue.config.js` now, and CI asserts none of the
five data filenames appear in the emitted service worker. Do not go back to
relying on a size threshold.

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
7. **A known-good copy is immutable until a replacement has proved itself**
   (August 2026). Rules 1–5 all cover an update that *fails*. They said nothing
   about an update that *succeeds at storing the wrong thing*, and
   `_downloadAndInstall` did `download → writeIndex → JSON.parse → load into
   WASM` — committing 42 MB to `ffIndexRaw` before anything established it was a
   usable index. Any 200 response that was valid JSON replaced the working copy:
   an error document, a captive portal's API reply, `nud-meta.json` from the
   wrong path, a truncated body that still closed its braces, a half-built
   dataset. The order is now:

   ```text
   download → JSON.parse → indexPayloadProblem → load into WASM → writeIndex
   ```

   **This was invisible for a whole session, which is what makes it the worst of
   the failures here.** During a background update the old index stays loaded in
   WASM and `_checkForUpdateInBackground` restores `READY`, so the app behaves
   perfectly until the next cold start — offline, when nothing can be done.

   `indexPayloadProblem()` (in `tuneIndexStore.js`) is the structural gate:
   settings and aliases objects, at least `MIN_PLAUSIBLE_SETTINGS` (100, against
   ~62k real) entries, and one sampled setting carrying string `tune_id` and
   `contour`. It samples rather than walks — the point is to reject documents
   that are not the tune index, not to validate 62k records. The floor is
   deliberately low: **a false rejection means the user can never update again**,
   which is worse than accepting an odd-but-small payload.

   The cost is holding the raw 42 MB string alive across the WASM load rather
   than releasing it just before, so peak memory during an install is higher.
   That trade is right: an OOM now fails *before* the write and leaves the
   previous copy untouched.

   `readIndex` applies the same check, so a bad payload written by a pre-fix
   build is cleared rather than kept forever. This narrows rule 3 — "a payload
   that parses is usable, full stop" — to "parses *and is shaped like a tune
   index*". Bookkeeping is still never grounds for discarding data; being a
   different document entirely is.

   **That read-side delete is gated on provenance**, because otherwise it
   reintroduces the very reasoning rule 8 forbids. It fires only when
   `manifest.schema === SCHEMA_VERSION` — i.e. *this* build's format, which is
   exactly the pre-validation-release case worth cleaning up. A manifest naming
   another schema, or no manifest at all, may be a **newer** format a later
   release wrote and this older client cannot recognise; that is not used, but
   it is not deleted either. Retaining it is free: `writeIndex` targets the same
   key, so the next validated download overwrites it regardless.
10. **Only one install runs at a time** (`_indexUpdateInFlight`). `_setupInFlight`
   could not cover this: setup fires the background update check *without*
   awaiting it (deliberately — readiness must never wait on the network) and
   then clears `_setupInFlight`, so tapping "Update offline copy" while the
   startup update was still downloading started a second install. Post-rule-7
   neither could store junk, but their writes interleave, and `ffIndexRaw` and
   `ffIndexManifest` are separate transactions — so the pair could end up
   crossed, a manifest from one install describing the payload of the other.
   `readIndex`'s byte-length check catches that only when the two payloads
   differ in length.

   A second caller **joins** the running install rather than queueing another:
   both want the same thing, and queueing means a second 42 MB transfer on what
   is usually mobile data. Which is also why `_snapshotIndexState` reads
   `_loadedIndexInfo` rather than `indexDetail` — a joiner takes its snapshot
   while the pipeline reads `downloading`, which carries no version, so
   restoring from `indexDetail` would report `v: undefined` on failure and blank
   the version display.
8. **Failing to consume the data is not proof the data is bad.** A cached copy
   that threw on `loadTuneIndex` used to be deleted on the spot, on the
   assumption that unloadable meant corrupt. On iOS the likelier causes are
   memory pressure, a worker killed mid-load, or a bug in that one build — all
   survivable at the next launch. It is now kept, the failure is recorded in
   `indexDetail.loadError`, and the app falls through to a download. A genuinely
   incompatible payload is not stuck forever: the next successful download
   replaces it, and rule 7's read-side check clears anything that stopped being
   a tune index at all.
9. **Status must never contradict usability.** `refreshTuneIndex`'s failure path
   asked `this.indexStatus === READY` *after* `_downloadAndInstall` had already
   set `DOWNLOADING`, so it always answered no: every failed manual refresh
   reported `UNAVAILABLE` while the old index sat in WASM answering queries,
   giving `status='unavailable'` with `usable=true`. Which of the two a given
   view happened to read decided whether the user saw tunes or an error, so the
   app looked randomly broken. Both update callers now take
   `_snapshotIndexState()` *before* starting and restore through
   `_restoreAfterFailedInstall()`, which reports `READY` + the old version +
   `updateError` when an index was loaded, and `UNAVAILABLE` only when one was
   not. `backend.indexReady()` is the client half of the same distinction: it
   resolves on `store.state.indexLoaded`, not on the status reading `'ready'`,
   so callers no longer block on a background download that has no bearing on
   whether their query works.

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
  of racing the one-shot `indexLoaded` event against your component's mount. It
  answers on **usability**, not on the status string, so a background update
  does not make it wait (see reliability rule 9).
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
- **`maximumFileSizeToCacheInBytes: 20 * 1024 * 1024` — without it the app does
  not work offline at all** (found August 2026). Workbox precaches nothing over
  **2 MiB** by default, and the WASM module is ~14 MB (tract, the ONNX runtime
  behind the ML transcriber, dominates it). So the one executable the entire app
  runs on was being dropped from the precache manifest, announced only by a
  build-log line:

  ```text
  /<hash>.module.wasm is 13.9 MB, and won't be precached.
  ```

  Everything still worked — *including the offline e2e tests* — because
  **Chrome's ordinary HTTP cache was serving it.** That cache is evictable and
  has nothing to do with the service worker, so the real behaviour was: open the
  app on a plane once the HTTP cache has turned over, and there is no query
  engine, no transcription, and a perfectly intact 42 MB tune index in
  IndexedDB that nothing can read. The failure the whole offline effort exists
  to prevent, hiding one layer below where anyone was looking.

  Note this sits above the ~14 MB WASM but well below the 42 MB dataset, so it
  doubles as the guard keeping the index out of the service worker — a local
  build does leave `folkfriend-non-user-data.json` in `public/res/`.

  Guarded now at both levels: CI asserts the emitted `.wasm` appears in
  `dist/service-worker.js` (and that the tune index does not), and
  `offline-index.mjs` asserts a `.wasm` is in CacheStorage and then **clears
  Chrome's HTTP cache before going offline**, so nothing below that point can
  quietly borrow it. Third instance of the same rule as the soundfont and
  `nud-meta.json` cases: **a required asset needs a post-build assertion, not a
  config option assumed to have worked.**
- **`runtimeCaching` holds exactly one entry, for map tiles** (August 2026).
  It was empty before that, and the reason it was empty still stands for
  everything else: the tune index must never be cached here (rule 1), because a
  second 42 MB copy of what is already in IndexedDB roughly doubles the chance
  the browser evicts the copy that makes the app work.

  Map tiles clear that bar and nothing else has: they are small, bounded by
  `maxEntries: 400` (~8 MB worst case), and are **not** a duplicate of anything
  in IndexedDB — without the cache they simply cannot be shown offline at all.
  `CacheFirst`, not StaleWhileRevalidate: a tile for a fixed coordinate does not
  change in any way a user of this app cares about, and revalidating would spend
  mobile data re-fetching identical PNGs on every visit to Places.
  `cacheableResponse.statuses` must include **0** — these are opaque
  cross-origin responses, and without it the cache silently stores nothing.

  **Anything else added here needs the same argument made explicitly.**

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

- `app/test/tune-index-cache.test.mjs` (30 cases) — the store and network layers
  with in-memory fakes. Quota failure, partial writes, corrupt payloads, legacy
  reads, stall aborts, the datasets manifest, filename validation, and the
  interruption walk described in rule 5 — which now seeds all three datasets and
  asserts **all three** survive an interruption at every storage operation of an
  update to *one* (P1).

  Its fake IndexedDB counts how often an injected fault actually **fired**
  (`failOnHits`). Fault injection here targets keys by name and the keys are
  namespaced per dataset now, so a test naming a key that no longer exists would
  inject nothing and then pass while testing nothing — worse than failing.
- `app/test/tune-index-install.test.mjs` (56 cases) — the *install* path, i.e.
  rules 7–10. It drives the real `worker.js` with its imports rewritten to fakes
  (in-memory IndexedDB, a scriptable network, a WASM stand-in that can refuse a
  payload), deliberately rather than a reimplementation: the bug was entirely in
  the ORDER of four statements, and a test restating that order would have
  passed against the broken code. Nine bad-but-plausible response bodies are
  each pushed through a background update, a manual refresh and a WASM refusal,
  and the assertion is always the same — read what is actually on disk
  afterwards and confirm it is still the complete, parseable, loadable previous
  version. Verified by reinstating each old behaviour in turn: the write-first
  ordering fails 11, delete-on-load-failure fails 3, the `wasReady`
  read-after-DOWNLOADING fails 1, unguarded concurrent installs fail 1,
  snapshotting from `indexDetail` fails 1, and an unconditional read-side delete
  fails 2.

  It also covers the multi-dataset rules above: partial success, the duplicate
  -content guard, disjoint installs being serialised rather than joined,
  migration from the merged blob (including a migration that dies part-way and
  one deferred because auto-update is off), toggling a dataset off and back on,
  and aggregated download progress. **Three of those tests found real bugs
  during development** — the `_partsToKeep` poisoning, the unclamped progress
  bar, and a fake that could not inject a mid-transfer failure.

  Its fake IndexedDB yields before committing each write, as a real transaction
  does — without that gap two overlapping installs interleave in lockstep and
  the concurrency test passes against racy code. Its fake network captures the
  response body when the request is *made*, not when it completes, so a download
  parked mid-flight cannot pick up a payload the test set afterwards. Both
  details are load-bearing; a fake that is too tidy proves nothing.
- `npm run test:e2e` — real headless Chrome, driven over CDP. See
  `app/test/e2e/README.md`, which also documents the traps (CDP network
  emulation does not reach Web Workers; Chrome's HTTP cache masks the failure;
  `.app` is HSTS-preloaded).

  `recovery.mjs` now also walks a **partial** update — one dataset served good,
  another served truncated — and asserts the failed one keeps its previous copy
  while its sibling updates. Note `INDEX_READY` is *not* "the install finished":
  the app becomes usable as soon as the first dataset loads, which is the whole
  point of partial success, so anything that reloads the page must wait on the
  IndexedDB keys instead. `waitForAsync` exists because `waitFor` wraps its
  expression in a synchronous arrow and does not await a promise.

  `recovery.mjs` **existed but was never in the `test:e2e` script**, so the one
  scenario closest to the field failure was not being run. It is now, and it
  bootstraps itself rather than needing the manual `cp -R dist dist-test && sed
  && npx serve` dance: it copies `dist`, rewrites the CDN origin in the emitted
  JS, and serves the result with an SPA fallback on :3001 alongside its
  controllable stand-in for the data host on :8444. It walks captive portal →
  recovery → **a newer version announced with a truncated body** → cold start
  with the host gone, asserting after the bad update that the manifest still
  names the same version and byte count. CI therefore no longer *deletes* the
  tune index before building — it moves it to `/tmp/ff-index/` and passes
  `FF_INDEX_JSON`, because the stand-in has to serve something real.

### IndexedDB (idb-keyval) — full key list

- `'favouriteItems'` — array of `FavouriteItem` objects (optionally carrying
  `aiSummary` and `aiSummaryDeletedAt`; both are synced)
- `'historyItems'` — array of `HistoryItem` objects (capped at 100)
- `'ffIndexRaw:<id>'` / `'ffIndexManifest:<id>'` — one tune dataset and its
  commit marker, per dataset (`thesession` / `folkwiki` / `norbeck`). Schema 3.
- `'ffIndexRaw'` / `'ffIndexManifest'` — the pre-multi-dataset merged blob
  (schema 2, read-only, migrated away)
- `'tuneIndex'` / `'tuneIndexMetadata'` — schema-1 tune index (read-only, migrated away)
- `'aiTuneSummaries'` — AI background notes, `{ tuneID: { text, model, generatedAt, sourceUrl } }`
- `'tuneSightings'` — where tunes were heard, append-only, capped at 5000. **Local-only, never synced**
- `'places'` — user-named locations, `{ id, name, lat, lon, radiusM, createdAt }`

Not IndexedDB, but worth listing alongside — localStorage keys: `'userSettings'`,
`'favouritesLocalUpdatedAt'`, `'anthropicApiKey'` (deliberately outside
`userSettings` so it stays out of exported backups), `'aiSummaryUsage'` and
`'aiSummariesClearedAt'` (the local, never-synced watermark that stops a stale
device resurrecting cleared notes).

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

### Session Analysis: live by default, short blips dropped, wrong tunes rejectable (August 2026 — v3.12.0)

Three changes to the Session Analysis view and the live pipeline behind it.

**Live microphone is the default mode.** The view opened on the file-import
panel, which is the rarer case — the common one is pointing the phone at a
session that is happening now, and that took a tap every time. `liveMode`
defaults to `true`.

Saved file results still win: `created()` switches back to file mode when
`store.state.sessionAnalysis` holds an audio file or detections, because landing
on an empty microphone panel having just analysed a recording reads as the
results having been lost. That restore has to run in `$nextTick` — setting
`liveMode` queues the watcher that calls `resetResults()`, so a synchronous
restore would be wiped by it. `?live=1` still forces live regardless.

**A tune only ever heard for a few seconds leaves the list.**
`filterShortPastDetections` (`sessionAnalysis.js`, `MIN_PAST_DETECTION_SECONDS`
= 15) drops detections shorter than the threshold. Two properties matter and
both are pinned by tests:

- **The last entry is exempt, always.** It is the tune being played right now
  and every tune necessarily starts short — and the follow overlay reads exactly
  that entry to decide what to display, so filtering it would blank the score
  for the first fifteen seconds of every tune.
- **It runs BEFORE `collapseConsecutiveSameTune`, not after.** A dropped blip in
  the middle of a tune then lets the two halves either side of it merge into one
  row; filtering afterwards leaves the same tune listed twice with a gap where
  the blip used to be. `_recluster()` exists so the three steps cannot drift
  apart across the two call sites (the analysis loop and `removeDetection`).

It is display-only — the window matches are untouched, so a detection dropped
here reappears on its own once it has accumulated enough span. 15 s is chosen
against the live defaults (10 s window, 5 s step): one spurious match spans 10 s
and two consecutive ones span exactly 15 s, so the threshold separates a
one-window fluke from something that was actually played.

**A wrong tune can be rejected from the follow view.** A thumbs-down button in
the `LiveScoreFollow` header calls `liveAnalysisService.rejectTune(tuneId)`,
which drops the detection (so it leaves the session's tune list too) and reverts
the display to the previous detection.

Four things this needs that are not obvious:

1. **A cooldown, or the button does nothing.** The same seconds of audio are
   still in the ring buffer and still match, so without suppression the rejected
   tune is back on the next cycle. `REJECT_COOLDOWN_SECONDS` is 120, applied by
   `_withoutRejectedTunes` at the *results* level so the next-best candidate is
   promoted rather than the whole window being discarded. Deliberately not
   permanent (a tune genuinely played later must still be findable) and
   deliberately not refreshed on each suppressed match, so the rule stays "two
   minutes" — something a user can predict.
2. **Rejection loops over the trailing clusters of that tune, not just one.**
   Two clusters of the same tune too far apart to merge are shown by
   `collapseConsecutiveSameTune` as *one* row spanning only the later one, so
   `removeDetection` drops only the later cluster's matches and the earlier one
   becomes the new tail — leaving the overlay on the same wrong tune, looking as
   though the button did nothing. Anything with a different tune after it is a
   separate hearing and stays.
3. **It rejects `detectedTuneId`, not `tuneId`.** After a manual override those
   differ, and what the user is disagreeing with is what the *analysis* said.
4. **It unfreezes and re-resolves from the service's own list.** The resolver
   discards everything while frozen, and the `detections` prop only catches up
   on the next render — so a rejection made while frozen, or resolved from the
   stale prop, would not move the view.

Tests: `filterShortPastDetections` in `sessionAnalysis.test.mjs` (loaded via
`test/helpers/loadSessionAnalysis.mjs`, which rewrites the module's two aliased
imports so node can load it), `liveAnalysisReject.test.mjs` (10 cases driving
the real service with its browser imports faked), and four cases in
`liveScoreFollowComponent.test.mjs` for the button wiring. Verified by
reinstating each bug: removing the filter fails 2, removing the cooldown fails
3, rejecting only the latest cluster fails 1, and dropping the unfreeze /
re-resolve fails 2.

### Favourites view took seconds to populate (August 2026)

On an older iPad the Favourites view sat blank for several seconds before
anything appeared. Nothing was slow about *loading* the data — `getFavourites`
is a single `idb-keyval` read of one array — it was all rendering, in one
synchronous pass, before the first paint.

**The dominant cost was engraving every ABC preview.** `FavouriteRow.abcSvg` is
a computed that calls `ABCJS.renderAbc` and hands the result to `v-html`, so it
ran inside the render that was supposed to put the view on screen. Measured in
headless Chromium on a desktop-class machine, one preview is ~3.8 ms and
produces several hundred SVG nodes; an older iPad is several times slower again,
so a few hundred favourites is seconds of blocked main thread before a single
row is visible — for scores that are almost all below the fold.

Two fixes, and they compose: the first cuts what each row costs, the second cuts
how many rows there are.

1. **A row only engraves once it is near the viewport.** `FavouriteRow` observes
   itself with an `IntersectionObserver` (400 px of lookahead) and
   `showAbcPreview` now requires `inView`. The gate is one-way — a row that has
   been engraved keeps its score rather than re-rendering every time it scrolls
   past.

   The gate has to be on `showAbcPreview`, which is what the `v-if` reads,
   *because* the engraving is a computed: a computed costs nothing until
   something reads it, and `v-if` short-circuits the `v-html`. Anything that
   reads `abcSvg` from outside that `v-if` puts the whole cost straight back,
   which is why `favouriteRow.test.mjs` counts calls into a faked ABCJS rather
   than asserting on the shape of `showAbcPreview`.

2. **The list renders a budget of rows and grows it on scroll**
   (`app/src/js/rowWindow.mjs`, `INITIAL_ROW_BUDGET` 24, `ROW_BUDGET_STEP` 24).
   Even with no preview a row is a `v-checkbox`, a `v-menu`, two `v-btn`s and a
   `TuneBackgroundButton`; a few hundred of those is its own delay.

   A sentinel element below the last row grows the budget when it scrolls into
   view. **The observer alone is not enough**: it only fires on a threshold
   crossing, and a sentinel that is already on screen and stays there never
   crosses anything, so growth would stall with the viewport half empty. Hence
   `_fillViewport()` in `updated()`, which re-checks the sentinel's position and
   grows again — one step per animation frame, so what is already rendered gets
   painted before the next batch is built. Growing in a tight loop would just
   reproduce the freeze.

Rules the tests pin, each verified by reinstating the bug:

- **Windowing never loses a row.** Growing the budget far enough must reproduce
  the unwindowed list exactly, and `hasMore` is true for exactly as long as
  something is held back. A window that silently dropped the last group would
  look identical on screen to a short list.
- **A collapsed group costs no budget.** It renders nothing, so charging it
  would leave every group below it stuck empty — collapse the top group and the
  rest of the list disappears. Its rows are still carried through, because the
  header shows their count and the group checkbox selects them. Removing the
  exemption fails 1 test.
- **Only *rendering* is windowed.** Selection, select-all, the tag/place chip
  counts, sharing and export all still run off `allRows` / `filteredItems`, so a
  row that has not been rendered yet is never an excluded one. This is the
  property that makes the whole thing safe to do.
- **Changing the filter, grouping or sort resets the budget**, since it changes
  what is at the top; otherwise a user who had scrolled to row 200 and then
  typed a name filter keeps paying to render 200 rows of a three-row list.
- **No `IntersectionObserver` means the old behaviour, not a broken list.** The
  row starts `inView` and `rowBudget` goes to `Infinity`. Slow, but never a list
  the user cannot scroll to the end of.

Also removed a wasted render pass: `FavouriteRow` measured its own width in
`$nextTick` + `requestAnimationFrame`, so every row rendered once knowing
nothing about its width and again a frame later. It is measured synchronously in
`mounted()` now (the element is already in the DOM), with the deferred read kept
as a safety net for a row that is not laid out yet.

**Not done: virtualising the list** (rendering only the visible window and
recycling rows). It would cap the cost rather than defer it, but it fights the
four grouping modes, the collapsible headers and the variable row height, and
progressive rendering plus the visibility gate already moves the expensive work
off the critical path. Worth revisiting if someone reports slowness while
*scrolling* rather than while opening the view.

Tests: `app/test/rowWindow.test.mjs` (13 cases, the pure budget arithmetic) and
`app/test/favouriteRow.test.mjs` (6 cases, the visibility gate — same
lift-the-SFC harness as `tuneBackgroundDialog.test.mjs`, with ABCJS faked so
engraving calls can be counted).

### Freeze in the follow score view (August 2026)

A pin button in the `LiveScoreFollow` header, to the right of the (i), holds the
current tune on screen. It lasts until unfrozen or until the overlay is closed —
it is not carried across a reopen via `setLastShown`, because a view silently
pinned to a tune that stopped being played some time ago has nothing on screen to
explain itself.

**The freeze is total, not just "don't switch tune".** `resolveFollowTarget` takes
a `frozen` flag and, when set, returns the previous target untouched: the match
score does not tick, and the override dropdown does not re-populate from what is
being played now. The point of freezing is to stop the view moving while you read
the dots off it, and those readouts move for the same reason the score does. It
also means a frozen tune survives the detections list clearing — the tune you
pinned does not vanish because the room went quiet.

**Unfreezing has to re-resolve explicitly.** The `detections` watcher only fires
when the array changes, and while frozen every one of those ticks was discarded,
so on unfreeze the component calls `_resolveFromDetections()` itself — otherwise
the view sits on the frozen tune until the next tune change and unfreeze looks
broken. That method is the watcher's body, extracted so both callers share it.

**The frozen state is announced in both footer layouts.** The footer has two
branches — the override dropdown plus a bare clock when the tune has
alternatives, a hint line otherwise — and the first one carries the only footer
text in that layout, so it needs the `Frozen · ` prefix too. Putting it only in
the hint line announced the freeze everywhere except the one layout where the
override dropdown is on screen.

Six cases in `liveScoreFollow.test.mjs` for the resolver (removing the `frozen`
early-return fails 5 of them; the sixth deliberately pins the *old* following
behaviour when the flag is omitted), and six in
`liveScoreFollowComponent.test.mjs` for the wiring the resolver tests cannot
reach: that `frozen` is passed on every tick, and that `toggleFrozen` re-resolves
on the way out. The latter follows `tuneBackgroundDialog.test.mjs` — lift the
SFC's `<script>` block, rewrite its imports to fakes, drive `data()`/`methods`
against a fake `this` with no Vue runtime — but keeps `liveScoreFollow.mjs`
real, since it is the far side of the wiring under test. Verified by mutation:
dropping the `this.frozen` argument fails 3, and making unfreeze skip the
re-resolve fails 2.

### Geo-tagged tune sightings (August 2026 — v3.10.0)

Records roughly **where** each tune was recognised, so the app can answer "which
session did I learn this at". Off by default (Settings → *Places*,
`userSettings.geoTagDetections`). New view at `/places`; a "Heard at" chip strip
on the Tune view.

`app/src/js/places.mjs` is the pure geometry and clustering,
`app/src/services/geo.js` is the location layer, `store.js` owns the log, and
`app/src/views/Places.vue` is the UI.

#### It is a log, not a field — and that is the whole design

The obvious implementation is a `lat`/`lon` on `HistoryItem` or `FavouriteItem`.
Both are wrong, for reasons that only show up once the feature is used:

- **`addToHistory` deliberately deletes the previous entry for a tune** (see its
  dedup loop). A location there answers "where did I *last* hear this", never
  "the six sessions this tune came up at" — which is the actual question. The
  same tune in several places is the normal case, not an edge case.
- **Starring happens on the sofa, days later.** A location captured at
  favouriting time is not merely absent, it is *wrong*, and confidently so.
- **Favourites sync to Firestore.** Coordinates there would push a log of the
  user's physical movements to the cloud and into every synced device, which is
  a materially different class of data from a list of tune IDs.

So sightings are their own append-only IndexedDB key, `'tuneSightings'`, capped
at 5000 (history's 100 is far too low — an evening that was not logged cannot be
recovered), **local-only**, and never touched by `sync.js`. A test asserts
directly that coordinates never reach `favouriteItems`.

#### Battery: one fix per session, and high accuracy on purpose

What drains a phone is `watchPosition` with high accuracy held open — the
navigation-app pattern. This never watches. `geoService.beginSession()` takes
**one** fix when a capture opens (live analysis start, or the record button) and
every sighting that evening is stamped with it; you do not move between tunes.
`FIX_MAX_AGE_MS` (30 min) bounds how long that holds, so a change of venue
mid-evening still re-fixes.

`enableHighAccuracy: true` reverses the obvious power-saving instinct, and
deliberately. The feature is "which pub"; a network-derived fix is 50–100 m,
which in a city centre is several pubs, so a coarse fix would save nothing
measurable and produce data that cannot answer the question. `maximumAge: 2 min`
lets the platform skip the radio entirely when it already knows where it is —
that is the real saving.

Set against what the app already does during a session (microphone open,
AudioContext running, every window through DSP or a 14 MB ONNX model), one fix
an evening is not measurable.

#### Rules the tests pin (each verified by reinstating the bug)

1. **The same tune in several places is never deduplicated.** Reinstating
   history-style dedup in `addSighting` fails 1 test. `SIGHTING_DEDUP_MS` is 60 s
   and exists only to collapse a double tap or two capture paths logging the same
   detection — a genuine A-B-A set must still record two hearings of A.
2. **Naming is retroactive.** People play somewhere for weeks before naming it;
   if naming only labelled future sightings the feature would look broken to
   exactly the people using it most. `namePlace` adopts every *unplaced* sighting
   inside the radius. Making it forward-only fails 2 tests.
3. **A sighting is recorded with no fix at all.** Refused permission, no signal
   in a cellar, or a slow radio must still leave "I heard this tune that night".
   Location is the bonus, not the record.
4. **Deleting a place keeps its sightings**, returning them to unplaced. They are
   observations; the name was only ever a label over them. Same reasoning as
   never deleting the offline index on a failure path.
5. **Concurrent callers join one acquisition** (`geo._inFlight`, assigned before
   the first await — same shape as `micService._healthCheck`). Removing it fails
   1 test. Several detections can land in one analysis cycle.
6. **A refusal is sticky for the run.** Retrying re-prompts on some platforms and
   spins the radio on others, and the user has just said no.
7. **A failed refresh keeps the previous fix** rather than nulling it, and a
   backgrounded app never requests a position — the prompt would be invisible and
   on iOS the request tends to hang.

#### The map, and the two things that nearly broke it

`app/src/components/PlacesMap.vue` — Leaflet 1.9, OpenStreetMap tiles.

**Loaded with a dynamic `import()`**, so it lands in its own chunk (146 KB /
42 KB gzipped) that never reaches a user who does not open Places, and a
failure to load it degrades to the scatter rather than breaking the view.

**Markers are `L.circleMarker`, never `L.marker`.** The default marker pulls PNG
icons through webpack's asset pipeline, which is the single most common
Leaflet-with-webpack breakage (`marker-icon.png` 404s at a hashed path). Circles
also carry the hearing count naturally, by *area* — scaling the radius linearly
makes a busy place look wildly more dominant than it is. Named places are
filled, unnamed ones hollow, because an unnamed place is a question the user has
not answered yet and the map is where they will notice it.

**Never put a `:class` binding on the element Leaflet is mounted into.** This
was a real bug, caught only by a browser check. Leaflet writes its own classes
straight onto the container (`leaflet-container`, `leaflet-touch`,
`leaflet-touch-drag`, `leaflet-touch-zoom`, the fade/zoom-anim classes); a
reactive class binding makes Vue re-render the `class` attribute whenever the
bound value changes, silently stripping all of them. A `ready` flag flipping
false→true was enough. **The map still looked perfect** — the panes Leaflet
created underneath keep their own classes — but the container lost
`position`/`overflow` and, critically, `touch-action: none`, so pinch and drag
on iOS quietly stopped working. That is the entire reason Leaflet is here rather
than a hand-rolled tile grid. State classes go on the wrapper.

The container class list is the assertion to make: after mount it must still
contain `leaflet-touch-drag` and `leaflet-touch-zoom`.

**Tiles are the one part of this app that genuinely cannot work offline the
first time**, which is why the tile-free scatter stays as a fallback rather than
being deleted. `PlacesMap` emits `unavailable` when *no* tile has loaded and
several have failed — a partial failure does not count, since a map drawn from
last week's cached tiles is still a useful map — and `Places.vue` swaps in the
scatter with an honest note about why. `scrollWheelZoom` is off: the map sits
inside a scrolling page, and grabbing the wheel would trap it.

Attribution is required by the OSM tile usage policy and is on by default via
Leaflet's attribution control. If this app ever gets real traffic, that policy
expects a different tile provider.

#### Filtering and grouping favourites by place

`Favourites.vue` gains a "Heard at" chip bar, above the tag bar, which only
appears once geo-tagging has produced places that actually contain favourites —
so it costs nothing for anyone not using the feature, and never offers a chip
that would filter to nothing (each carries its match count).

Two decisions worth knowing:

- **Places are OR; tags are AND.** Selecting two tags means "has both", which is
  the useful reading for labels the user applied deliberately. Selecting two
  places means "heard at either" — a tune heard at *both* of two named pubs is a
  rare thing to ask for and would usually filter to nothing.
- **`placeIDsByTune` is a computed index**, not a per-row lookup. Favourites are
  matched to sightings by `tune_id` (sightings are per tune, favourites per
  setting), and doing that as a nested scan would run over the whole sightings
  log on every keystroke in the name filter.

A place deleted from the Places view is dropped from `activePlaceIDs` on reload —
otherwise the list stays filtered against something no chip can clear.

**Grouping** is the fourth mode on the existing group-by button (none → tag →
date → place), ordered by most recently heard there, so last night's session is
at the top when someone opens the view after a session. Three details:

- **A tune heard at three sessions appears under all three.** That repetition is
  the answer to "what do we play here", not a bug — and it matches the tag
  grouping, where a row already appears under each of its tags.
- **`place` is skipped in the cycle when there is nothing to group by**, so
  anyone not using geo-tagging does not tab through a mode that can only show one
  "Not heard anywhere yet" heading.
- **Under an active place filter, only the filtered places get headings**, and
  the "Not heard anywhere yet" group is suppressed entirely — those favourites
  are precisely what the filter was asked to exclude.

#### No reverse geocoding

Place names come from clustering the user's own coordinates, not from a geocoding
service. A geocoder means a third-party request carrying the user's location
off-device, and it stops working exactly where this app is supposed to keep
working. Instead: a sighting stores raw coordinates, the user names a spot once,
and `sightingsToAdopt` labels everything within the radius. After two or three
evenings the tagging is automatic, fully offline, and the names are the ones the
user actually says.

`DEFAULT_PLACE_RADIUS_M` is 150 (per-place overridable — a festival field and a
back room are not the same size); unnamed proposal clusters use a tighter 80,
because merging two proposals by giving them one name is easier for a user than
splitting one that swallowed the pub next door.

Note this is a different decision from the basemap. Tiles are a picture the user
looks at; a geocoder would be told *where they were*, which is the part that must
not leave the device. Tiles are fetched by z/x/y for an area the user is already
looking at, and the tile server is never sent a place name, a tune, or anything
tying the request to this user.

The **tile-free SVG scatter** is still there as the fallback when tiles cannot be
reached — shape and grouping are real, absolute geography is not, and the page
says so. Dot area (not radius) tracks the count.

#### Where sightings are captured

- **`liveAnalysis._recordSighting()`** — the important one. An evening in a pub
  is 30+ hearings that previously vanished entirely: follow mode recognises tune
  after tune and wrote nothing unless something was starred. It logs on the
  **edge**, when the tail detection's `tuneId` differs from the last logged one.
  `collapseConsecutiveSameTune` has already merged a continuing tune into one
  tail entry, so that edge is exactly the musical event wanted — and A, B, A
  across an evening correctly gives three sightings. Recording per cycle would
  log one reel forty times. Fire-and-forget: a sighting must never delay or break
  the analysis loop.
- **`ResultRow.addToHistory`** — tapping a result is the user confirming which
  tune it was, which makes it the honest moment on the search path (the query
  itself produces a ranked list, not an identification). `RecorderButton` warms
  the fix when recording starts, so the tap reads a cached value.

`HistoryRow` still has no capture point: it is passed only
`name`/`descriptor`/`timestamp` and carries no tune identity.

#### Creating places, not just naming what was recorded

At first a place could only come into existence one way: play somewhere with
geo-tagging on, then name the cluster that produced. That covers the pub you
were just in and nothing else — you could not set up the session you are going
to on Tuesday, or move a pin that landed in the car park.

`PlacePickerDialog.vue` adds an explicit "Add a place", with three ways to
choose a point, in the order people reach for them:

1. **Tap the map.** The primary route, and the reason Leaflet was worth adding.
2. **Take a fix** ("Use my location"), via `geoService.requestPermission()` — a
   deliberate tap is the right moment for the OS prompt, and an earlier refusal
   must not leave the button permanently inert.
3. **Type coordinates.** Not a power-user afterthought: the map needs tiles and
   tiles need a network, so offline with nothing cached the first route is gone.
   The panel opens itself automatically when the map fails.

The same dialog handles naming an unnamed cluster and editing an existing place,
so there is one code path for all three. Naming a cluster starts the pin at its
centre — the picker is there to nudge it, not to make the user find it again.

**The radius is drawn as a live circle on the map**, not just a slider value. It
is the setting that decides which past hearings the new name adopts, and 150 m
means nothing until you see it over a street. Other places are drawn faintly for
context, which is what stops someone unknowingly creating a second pin for a pub
they already named.

**`groupSightingsByPlace` had to change to list places with no hearings.** It
previously returned only places that had sightings, which was correct when the
only way to create one was to record there — and silently wrong the moment
places could be created deliberately: saving a new place left the Places view
still saying "Nothing recorded yet", so it looked like the save had failed.
Empty places sort last, having `lastSeen` 0. Two tests pin this, both verified
against the old filter.

**Not built: search by place name.** It is the obvious convenience — type "The
Cobblestone" instead of panning — and it would need a geocoder such as
Nominatim. That is a *different* privacy question from the reverse geocoding
this feature has always refused: a forward search sends a string the user typed,
not their coordinates. It is defensible, but it adds a third-party dependency
and a usage policy to respect, so it is a deliberate open decision rather than
an oversight.

#### Correcting the log by hand

Automatic capture has two failure modes no amount of tuning removes: the
detector sometimes identifies the wrong tune, and it never hears the tunes
played while the phone was in a pocket. Without a way to correct that, the log
is a subset of the truth with errors baked in — so both directions are editable.

**Un-tagging** works at **tune-at-place** granularity
(`store.removeTuneFromPlace(tuneID, placeID)`), not per hearing. That is the
claim the UI makes ("Heard at The Cobblestone ×3") and therefore the claim the
user is disagreeing with; removing one of three would leave the chip in place
and look like nothing happened. `placeID` of `null` targets the unnamed bucket,
which is what the "an unnamed place" chip refers to. Two entry points: the ✕ on
each "Heard at" chip on the Tune view, and a ✕ per tune row under a place on the
Places view.

**Every removal is undoable**, and `restoreSightings` puts back the *whole
records* rather than re-adding them, so an undone removal keeps the original
timestamps and does not quietly rewrite when the tune was heard. Sightings
cannot be recreated after the fact and the chips are small targets on a phone,
so a mis-tap must not be final. `Places.vue::notify(text, undoable)` gates the
Undo button — without that flag a later unrelated message inherits the previous
removal's records and offers to undo something the user was never told about.

**Manual tagging** is `TunePlaceDialog.vue`, opened from an "Add place" chip on
the Tune view, with two ways in for two genuinely different situations:

- *"I'm here now"* takes a fix, for tagging in the pub. It calls
  `geoService.requestPermission()` rather than `getFix()`, because a deliberate
  tap is the right moment to raise the OS prompt and an earlier refusal must not
  leave the button silently doing nothing forever.
- *Picking a named place* needs no fix at all, for tagging afterwards — where a
  fix would be both unavailable and actively wrong. That is the same reasoning
  that made sightings a separate log rather than a field on favourites.

`addSighting` grew `placeID` and `source: 'manual'` for this. Three details that
are easy to get wrong:

1. **The place is resolved before the duplicate check, not after.** A manual
   "here now" must be compared against sightings at the place its fix lands in,
   not against the unplaced bucket — otherwise an existing unplaced sighting for
   the same tune silently swallows it. This was a real bug, caught by a test.
2. **Manual adds skip the time-window dedup** (`SIGHTING_DEDUP_MS`), which
   exists to collapse double taps during live capture. The user is deliberately
   adding something the detector missed, possibly months later. They are instead
   deduplicated by **(tune, place)**: "this tune was heard here" is either true
   or not, so recording it twice adds nothing — and the existing record is
   returned so the caller still sees success.
3. **An explicit `placeID` naming no known place is refused**, rather than
   falling back to an unplaced sighting. A record the user cannot see anywhere
   is worse than no record.

#### Export includes them; sync never does

`exportUserData` is now **version 4** and carries `tuneSightings` + `places`.
This is the only copy of that data — it is never synced — and a backup that
silently drops the one dataset that cannot be regenerated is not a backup. The
Settings panel says plainly that a backup file therefore discloses where the user
has played. `importUserData` accepts v1–v4 and only writes the keys when present,
so restoring an older backup does not wipe sightings recorded since.

#### Tests

`app/test/sightings.test.mjs` (40 cases, in the `npm test` chain) — geometry and
clustering, the store log, and the geo service, with `store.js` and `geo.js`
loaded from source against in-memory fakes and a scriptable `navigator.geolocation`.
`places.mjs` is used **for real** rather than faked: it is pure geometry with no
browser surface, and stubbing it would weaken the store tests that depend on
proximity matching.

Note `aiSummaryStore.test.mjs` also had to learn about `places.mjs`, since
`store.js` now imports it — its loader copies the real module alongside `schema`.

### AI tune background notes (August 2026 — v3.9.0)

An **(i)** button on the Tune view writes a ~10-line program note about the tune —
origin, earliest documented date, the story attached to it — via the Claude API
using the **user's own** API key. Off by default (Settings → *AI Tune Summaries*).

`app/src/services/aiSummary.js` is the whole network layer;
`app/src/components/TuneBackgroundButton.vue` is the (i) button,
`app/src/components/TuneBackgroundDialog.vue` the panel it opens; `store.js` owns
the cache, the key and the spend counter.

#### One dialog, four buttons

The button appears on the Tune view, on each search result row
(`ResultRow.vue`), on each favourite (`FavouriteRow.vue`) and in the live session
follow view (`LiveScoreFollow.vue`). The **dialog is mounted once, in `App.vue`**,
and buttons open it with `eventBus.$emit('showTuneBackground', { tuneID,
displayName, sourceUrl })`.

That split is not cosmetic. A per-row dialog would instantiate one `v-dialog` per
favourite — a lot of DOM for something at most one of which is ever visible — and
would copy the cost guardrails (cache-first, never generate without a tap, single
in-flight request) into four places. Centralising introduces exactly one new
failure mode, and the dialog guards it: `show()` clears `summary`, `grounding`
and `commentCount` **when the tune ID changed**, so opening the panel for tune B
can never show tune A's note.

`FavouriteRow` takes `tuneID` and `sourceUrl` as their own props rather than
digging them out of `setting`, because the tag- and date-grouped favourite lists
deliberately do not bind `setting` (no ABC preview there) and would otherwise
lose the button. `Favourites.vue::_toRow` lifts both out.

`HistoryRow.vue` has no button: it is passed only `name`/`descriptor`/
`timestamp` and carries no tune identity at all, so adding one means changing
what `History.vue` passes down.

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
fallback path must rebuild the prompt, not just strip the tool.

**The actual cause of that first failure was our own allowlist.** With the `www.`
variant added the fetch started working, so a redirect between `thesession.org`
and `www.thesession.org` was being blocked by `allowed_domains`. It surfaced as a
"network issue" the model reported in prose, which is about as indirect as a bug
report gets.

#### Then the notes were shallow (August 2026)

Once the page was reachable, notes came back restating the tune's aliases, key
and type — all of which the Tune view renders inches above the note — with almost
no history. Three causes, two of them self-inflicted:

1. **We were feeding it the metadata and telling it to prefer it.** `factsBlock`
   listed title/aliases/type/meter/key/setting-count under the heading "Known
   facts from the source database (authoritative — **prefer these over the
   page**…)". That is an instruction to write about metadata. Meter, mode and
   setting count are no longer collected at all, and what remains is labelled
   identification-only with an explicit "none of it belongs in your note".
2. **The prompt never said what to leave out.** It now names the five things the
   UI already shows (aliases, key/mode/meter, tune type, setting count, melodic
   description) and forbids them, and asks in priority order for geography,
   dates, named sources, named people, and disputes — "prefer specifics over
   characterisation".
3. **`max_content_tokens: 6000` was probably truncating before the comments.** A
   thesession page carries a full ABC block *per setting* above the discussion,
   and notation is token-dense, so on a tune with many settings the budget was
   spent before the comments began — leaving the header metadata as the only
   thing the model actually saw. Raised to **30000**, and the prompt now says
   explicitly that the notation is near the top, the discussion is lower down,
   and the discussion is the point.

#### And then the model stopped being asked to fetch at all (August 2026)

Raising the budget did not fix it either, because truncation was never the cause.
The decisive observation came from a note on tune 1316 (*Maggie's Pancakes*)
generated with **Sonnet 5**: it claimed no documentary record existed, while the
page names the composer in its *first line* and carries 36 comments including the
composer's own post dating the tune to Live Aid day. Two things follow:

- Truncation keeps the **top** of a page, so any page content at all would have
  carried the composer. Not a `max_content_tokens` problem.
- The dialog showed **no caveat**, meaning `pageRead === 'ok'` — the tool ran and
  reported success — while the model plainly had nothing. Sonnet 5 uses the
  `_20260209` web_fetch variant, whose dynamic filtering runs code over the page
  before it reaches the model; on a page that is mostly ABC notation and link
  lists that can discard the discussion entirely.

So **`pageRead === 'ok'` is worthless as a quality signal** — worse, it silently
told the reader the source had been read when it had not, which is what hid this
for two rounds. It is replaced by `grounding`
(`'comments' | 'page' | 'knowledge'`), and the page path only counts as grounded
when `pageFetchStats()` reports substantial text that reaches the comments.

**The app now fetches the discussion itself and puts it in the prompt**
(`fetchSessionComments`): `?format=json` first (that origin+format is
CORS-proven), falling back to the HTML page parsed with `DOMParser`, selecting
`[id^="comment"]` and then a comments-heading slice. When comments are in hand the
`web_fetch` tool is **not offered at all** — leaving it attached invites a
re-fetch and reintroduces the filtering step that lost them.

This is cheaper as well as better: a few thousand tokens of prose instead of tens
of thousands of notation, so `WEB_FETCH_MAX_CONTENT_TOKENS` went back down to
10000 (it now only governs the fallback) and the default model stays Haiku 4.5 —
with the material supplied, a cheap model summarising real text beats an
expensive one guessing.

> ⚠️ **Whether thesession.org sends CORS headers on HTML is unverified.**
> `?format=json` demonstrably does; the HTML page is a bet. It could not be tested
> from a Claude Code session (the host is blocked by egress policy), which is why
> the JSON attempt comes first and the whole thing degrades to `'knowledge'`
> rather than failing. If `grounding` reads `'page'` or `'knowledge'` on every
> tune in the field, that bet lost and the next step is a read-only proxy — which
> this repo has no infrastructure for.

`estimateCostPerNoteUsd()` derives the Settings figure from `MAX_COMMENTS_CHARS`,
so changing the cap cannot leave a stale (flatteringly cheap) number on screen:
~$0.009 per note on Haiku 4.5 and ~$0.027 on Sonnet 5, once per tune, cached
forever.

**`pageFetchStats()` is how to tell whether any of this worked**, since "the
fetch succeeded" and "the model saw the comments" are different claims. It digs
the fetched text back out of the `web_fetch_tool_result` and reports its length
plus whether comment markers appear; it is logged to the console on every
generation and printed by `scripts/probe_tune_summary.mjs`. If `looksLikeComments`
is false, the budget is still too small — that is the number to raise.

> ⚠️ **`thesession.org` is blocked by the sandbox egress policy**, so none of the
> above could be verified from a Claude Code session — not by `curl`, not by
> `WebFetch`. The unit tests fake the network. Whether the discussion actually
> reaches the model can only be established on a real device or with a real key
> via the probe script, which is exactly what `pageFetchStats` exists to answer.

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

**The other half of that hazard: deletion cannot be encoded as absence.** The
repair above is *why* — `_reapplyAiSummaries` is supposed to treat a favourite
with no `aiSummary` as a device that never generated one, and restore it. So
"Clear saved notes" stripping the mirrors was undone by the user's other device:
it read the deletion as ignorance, put its own cached copy back and pushed it.
The confirm dialog promises the clear reaches "your synced favourites", so this
was a broken promise, not just a design choice.

`clearAiSummaries` therefore writes a tombstone, **`FavouriteItem.aiSummaryDeletedAt`**
(millis), onto *every* favourite — not only ones that currently carry a mirror,
because another device may hold a note this one has never seen and "clear all"
has to reach that too. `_harvestAiSummaries` honours a tombstone newer than the
local copy by deleting it; `_reapplyAiSummaries` refuses to restore under one.
`setAiSummary` **deletes the tombstone** when it mirrors, so regenerating after a
clear wins. Both comparisons use `>=` deliberately: a clear and a generate in the
same millisecond is unresolvable either way, and what matters is that the two
functions agree — disagreeing would let the pair delete in one and restore in the
other on the same snapshot.

**The synced tombstone cannot protect the device that wrote it.** Favourites sync
is whole-document last-writer-wins, arbitrated by a document-level `Date.now()`
(`sync.js`, `clientUpdatedAt`). A device that has not yet processed the clear can
touch an unrelated favourite and push its whole array — still carrying the note,
and with no tombstone, because it never saw one — and that write is legitimately
newer *at the document level*. Reconciliation only ever sees the incoming array,
so the tombstone this device wrote is not in the conversation, and `!existing`
cannot tell "never had it" from "deleted it". The note came back.

So there is also a local watermark, **`localStorage['aiSummariesClearedAt']`**,
never synced. `_harvestAiSummaries` drops any incoming note with
`generatedAt <= clearedAt`; `_reapplyAiSummaries` strips such a note from the
inbound array and **re-stamps the tombstone**, so the correction propagates —
without that the two devices trade the note back and forth forever, because the
only device that knows it was deleted never says so.

A single timestamp, not a per-tune tombstone map, for two reasons: "Clear saved
notes" is inherently clear-*all*, and per-tune markers cannot cover a note the
*other* device holds and this one never had — there is no local marker to consult
for that tune and the stale write carries none either. `npm test` pins that case
specifically.

**Protection has to be transitive, so an incoming tombstone advances the
watermark.** `_adoptIncomingClear` takes the newest `aiSummaryDeletedAt` in a
snapshot and raises the local watermark to it (`max`, never lowering).
Without it only the device where Clear was pressed is defended: a device that
merely *hears* about the clear deletes its copy and is then defenceless — no
cached note left to compare against and no watermark of its own — so a third
device that never saw the clear resurrects the note there. It runs as a pre-pass
rather than inside the reconciliation loop, so a tombstone and a stale note in the
*same* snapshot are both judged against the clear and item order cannot decide
the outcome.

⚠️ That promotes a per-favourite marker into a global watermark, which is only
sound because `aiSummaryDeletedAt` is written in exactly two places and both mean
clear-*all*: `clearAiSummaries`, and the re-stamp in `_reapplyAiSummaries` (which
derives from this same watermark). **A per-tune delete must not reuse that
field** — it would read as "clear everything older than this" and take out
unrelated notes.

`importUserData` clears the watermark first: restoring a backup is an explicit
request for its contents, so it outranks an earlier clear rather than having its
older notes silently filtered out.

This is wall-clock across devices, so a badly skewed clock can still slip a note
through. Every other conflict decision in favourites sync has the same exposure,
and losing this one costs a resurrected note rather than a lost one.

#### The async race that the tune-ID guards do *not* cover

`TuneBackgroundDialog.generateSummary()` captures **every** input to the request
synchronously, before the first `await`, into a `request` object. Reading
`displayName` or `sourceUrl` off `this` after an await is a bug: the dialog is
dismissible by tapping outside it, so the user can reopen it for another tune
while the comment fetch is still in flight, and tune A's note then gets built
with tune B's title and page URL — and saved under A. `sourceUrl` also derives
`allowed_domains`, so a crossed request is pointed at the wrong page, not merely
mislabelled.

The `String(this.tuneID) === String(tuneID)` guards further down govern only what
is *displayed*. They cannot un-poison a record that has already been written.
This got materially more reachable when the (i) button moved onto list rows,
where dismiss-and-tap-the-next-row is a natural gesture.

`app/test/tuneBackgroundDialog.test.mjs` pins it by holding
`fetchSessionComments` unresolved, switching the dialog to another tune, then
releasing. It needs no Vue runtime: the component is a plain Options-API object,
so the test lifts its `<script>` block out of the SFC, rewrites the three
imports to fakes, and calls `methods.generateSummary` against a fake `this` built
from `data()`. That only works because the network layer is kept out of the
component — worth preserving.

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
- `app/test/aiSummaryStore.test.mjs` (23 cases) — both storage invariants above.
  The deletion half is covered from seven angles, because each one fails a
  different plausible implementation: a tombstoned deletion must not be
  resurrected; a *stale device's* push must not resurrect it either; nor must one
  for a tune this device never held; a *third* device must not resurrect it at a
  device that only heard about the clear; a note generated elsewhere *after* the
  clear must still be accepted, including after an adopted clear; and a
  regenerate on this device must stick. Plus key exclusion from backups,
  truncation, mirror targeting, and spend accounting.
- `app/test/tuneBackgroundDialog.test.mjs` (8 cases) — the shared dialog: the
  request is built only from the tune it started for, a late result is saved but
  not shown, opening never generates, reopening a different tune clears the
  previous note, and a double tap collapses to one paid call.
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
