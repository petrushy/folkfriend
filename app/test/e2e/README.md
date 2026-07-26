# Offline tune-index end-to-end tests

These drive a real headless Chrome over the DevTools Protocol (no npm test deps)
to check the behaviour that makes FolkFriend usable without a connection.

They exist because this area is easy to break silently: the app looks fine
online and only fails on a plane, hours later, with no way to debug it.

## Why not just CDP network emulation?

The tune index is fetched **from a Web Worker**. `Network.emulateNetworkConditions`
is scoped to the target you send it to and does not reliably reach dedicated
workers, so "offline" emulation alone lets the download quietly succeed and the
test passes for the wrong reason. Chrome's HTTP disk cache does the same — it
happily serves a cached 40 MB response with the origin unreachable, which
Safari/iOS will not do. Hence `--disk-cache-size=1` everywhere and, for the
"host unreachable" cases, `--host-resolver-rules` (which applies at the network
stack, to every context).

## Running them

All three need the **production** build (they need the service worker):

```sh
cd app
npm run build
npx serve dist -s -l 3000
```

### settings-wiring.mjs — Settings controls are actually connected

```sh
node test/e2e/settings-wiring.mjs
```

Guards a failure mode Vue 2 makes easy and silent: a template that names a
handler which no longer exists. Nothing throws — the click is simply dropped,
which looks identical to a broken feature. (This is exactly how a refactor of
the Tune Data card removed `signIn`, `settingsChanged`, `onMlTranscriberChanged`
and `onRecordingLimitChanged`, and Google sign-in stopped responding.)

Asserts every handler named in the template resolves on the component, that
clicking "Sign in with Google" really enters `signIn()` (observing `signingIn`
flip synchronously), that Firebase opens its auth popup, and that the page logs
no `[Vue warn]`.

### offline-index.mjs — an offline copy exists

```sh
node test/e2e/offline-index.mjs
```

Covers: first install persists the index; the duplicate service-worker copy of
the index is gone; reload with the network fully offline works; tunes open
instantly offline; a pre-existing schema-1 (old format) copy still works offline
and is migrated on the next version bump.

### unreachable-host.mjs — no offline copy, host unreachable

```sh
node test/e2e/unreachable-host.mjs
```

Simulates aeroplane/captive-portal Wi-Fi two ways — connection refused, and
connection blackholed so it hangs — with `navigator.onLine` still `true`.
Asserts the app gives up quickly and tune views fall back to favourites without
stalling.

### recovery.mjs — host comes back while the app is open

Needs a build whose data URL points at a local stand-in origin, because
`folkfriend-data.web.app` is HSTS-preloaded (a self-signed stand-in for it is
rejected no matter what flags you pass):

```sh
cd app
cp -R dist /tmp/dist-test
sed -i '' 's|https://folkfriend-data.web.app/|http://127.0.0.1:8444/|' /tmp/dist-test/js/*.js
npx serve /tmp/dist-test -s -l 3001
node test/e2e/recovery.mjs
```

Asserts that a stalled host is abandoned, nothing half-written is persisted, and
that the index installs and saves itself as soon as the host answers — without
the user restarting anything.

## Gotchas when editing these

- Give the stand-in origin an `Access-Control-Allow-Origin` header. Without it
  the fetch fails with an opaque `TypeError: Failed to fetch` that looks exactly
  like a dead network.
- If the stand-in "hangs" a request, destroy its sockets before it starts
  serving again. HTTP/1.1 responses are ordered, so a later response would sit
  queued behind the one that never came, and a recovered server still looks dead.
- A freshly installed service worker only takes control on the *next*
  navigation; check `navigator.serviceWorker.controller` before going offline.
- After `Page.navigate` the old DOM lingers briefly — wait for a marker on the
  new document before asserting on readiness selectors.
