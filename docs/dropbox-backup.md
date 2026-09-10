# Dropbox recording backup

FolkFriend uploads recordings directly from the browser to a user-owned Dropbox
App Folder. Firebase continues to sync lightweight session records and never
receives audio, Dropbox credentials, or audio manifests. Backup is off by default.
Connecting explicitly opts this device into backing up all its existing and future
recordings. Disconnecting stops uploads and removes the saved access token;
it does not delete Dropbox files. Users can revoke the app in Dropbox as well.

## Deployment setup

1. Register one scoped application in the [Dropbox App Console](https://www.dropbox.com/developers/apps).
   Select **App folder**, not Full Dropbox, and name it FolkFriend (the actual
   app name determines `/Apps/<app-name>`). This access restriction is enforced
   by Dropbox's app configuration, not by a client-side scope string.
2. Enable `files.metadata.read`, `files.content.read`, and `files.content.write`.
3. Register the exact application base URL as an OAuth redirect URI, including
   its trailing slash. Register development and preview URLs separately when
   needed. For example, `http://localhost:8080/` for local development.
4. This build uses the public FolkFriend app key `zl982bc269ijgda`.
   To use a different Dropbox app, set `VUE_APP_DROPBOX_APP_KEY=<public app key>`
   in `app/.env.local`, then rebuild.
   For GitHub deployment, set the repository Actions variable
   `VUE_APP_DROPBOX_APP_KEY`; the deployment workflow passes it to the build.
   **Do not configure or ship an app secret.**
5. Open Settings → Dropbox backup → Connect Dropbox. Allow the sign-in popup.
   The popup prevents authentication from navigating away from a live recording.
   A blocked popup reports an error and leaves recording running.

OAuth uses state and S256 PKCE, short-lived online access tokens, and no refresh
token. Tokens and consent are device-local, outside settings exports and Firestore.
They are stored in localStorage to survive reloads until expiry. Expiry or revocation
shows Reconnect required; reconnection retries uploads and pending playback.
See the [Dropbox OAuth guide](https://developers.dropbox.com/oauth-guide).

## Files and safety

```
/Apps/FolkFriend/sessions/<session-id>/
  segments/000000.m4a  # extension follows the track's actual encoder
  session.json
  audio-manifest.json
```

Segments preserve the recorder's original bytes and are immutable: existing bytes
must match the Dropbox content hash or backup stops. The cloud manifest has
`cloudSchema: 1` and local `schema: 1`. It preserves timing, formats, tracks,
gaps, mute ranges, and chunk offsets; container initialization blobs are encoded
as base64 in each track. Raw continuation segments may need that header to play;
they are not promised to be standalone files. The existing player reconstructs
playable clips and exports using those headers, just as for local recordings.

Audio uploads first, the complete session record second, and the manifest last.
Every upload response is checked against Dropbox's size and block-based SHA-256
content hash. Existing JSON files use revision-conditional writes, with automatic
renaming disabled. Unknown formats, failed reads, missing local segments, or
conflicting copies stop the operation without replacing the cloud manifest.
A durable pending-session receipt allows retry after a crash between session and
manifest writes. A stale device cannot truncate a longer cloud recording.
Conflicting tune edits require review; this implementation does not merge them.

While the app is open, committed recordings and session edits trigger backup;
a 30-second timer, returning online, and returning to the foreground retry pending
work. Rate-limit retry delays are respected. No service worker background upload
is assumed. Backed up means the stored snapshot was verified; while capture is
running the display remains Syncing because another segment may still be pending.
Unchanged receipts are periodically reverified. Local recording never waits on
Dropbox, and originals are never automatically evicted after uploading.

The session ID locates cloud audio for a Firestore-synced session. Settings →
Restore sessions from Dropbox also reconstructs missing session records from
`session.json`, without replacing existing local edits. This works without a
Firebase record or Firebase sign-in. Opening a remote session downloads only
needed segments. A separate least-recently-used cache holds up to 32 MiB and
respects the existing 150 MiB storage reserve. Caching failures do not prevent
playback. Cached segments can play offline while Dropbox remains enabled.

Delete local audio and Delete Dropbox copy are separate, explicit actions in the
session recording panel. Cloud deletion requires readable, recognized manifests
and disables automatic backup for that session; Retry backup enables it again.
Deleting the session itself deletes its local audio but leaves its Dropbox copy.
Dropbox restore can therefore recover a session deliberately removed locally.
Close an open recording session before deleting its audio through these controls.

## Verification

`npm --prefix app test` includes `app/test/dropbox.test.mjs` and `app/test/dropboxIntegration.test.mjs`, covering interrupted
uploads, commit ordering, immutable conflicts, revision races, failed/unknown
reads, hash checks, recovery metadata, consent, independent deletion, and auth/quota/rate errors.
The session workspace browser suite also decodes a cached cloud-only WAV in the
existing player with expired authorization, at mobile width.

Before release, use the configured app with a real Dropbox account on iPhone:
connect while recording; cross a three-minute boundary; go offline and reconnect;
close and reopen; expire authorization; restore on another device; seek and export
across multiple segments/tracks; and exercise independent deletion. Automated
transport tests do not establish iPhone microphone or Dropbox account behavior.
