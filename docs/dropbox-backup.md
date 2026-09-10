# Dropbox audio storage alongside Firebase sync

FolkFriend uploads recordings directly from the browser to a user-owned Dropbox
App Folder. Firebase continues to sync lightweight session records and never
receives audio, Dropbox credentials, or audio manifests. Backup is off by default.
Connecting explicitly opts this device into backing up all its existing and future
recordings. Disconnecting stops uploads and removes the saved access token;
it does not delete Dropbox files. Users can revoke the app in Dropbox as well.

## Account sync and audio access

Firebase remains the account sync service: devices signed into the same FolkFriend
account receive sessions, tune lists, favourites, history and places through the
existing Firebase integration. Users supply their own Dropbox capacity for audio;
FolkFriend does not host those recordings in Firebase storage.

On every device, sign into the same FolkFriend account and authorize the same
Dropbox account. Open a session from the usual synced session list to play its
Dropbox audio. Dropbox authorization is separate on each device; logging into
FolkFriend alone does not grant Dropbox access. The implementation does not yet
bind a Dropbox account ID to a Firebase user, so users must select the same
Dropbox account themselves.

The session JSON stored beside recordings is a disaster-recovery copy. Recover
missing sessions is for lost records, not the normal cross-device workflow.

## Who does what

**Nothing in this section is a user step.** A Dropbox app is registered **once,
by whoever ships FolkFriend**, and the resulting *app key* identifies the
application — not a person. It is public by design, which is why the OAuth flow
uses PKCE and no secret is shipped. Every user of that build shares it.

What a user does is: Settings → Dropbox audio storage → **Connect Dropbox**,
sign in, approve. That is all. They never see the App Console, never need an app
key of their own, and there is deliberately no field to paste one into — that
would push a developer's concern onto everybody who just wants their tunes
backed up.

> ⚠️ **A new Dropbox app is capped until it is approved for production.** Dropbox
> starts every registration in *Development* status, which limits how many
> Dropbox accounts may link it (50 at the time of writing). That is ample for a
> personal fork and is the one real barrier to "any user can just connect" —
> going beyond it means applying for production approval in the console. Check
> the current limit and status on the app's page before assuming otherwise.

## Deployment setup (done once, by the person shipping the app)

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
5. Optional: to show the user how much space is free in their Dropbox, also
   enable `account_info.read` under Permissions and Submit. Without it,
   FolkFriend still reports how much it has stored; only the account's free
   space is unavailable, and the panel says so rather than failing. Users are
   asked to approve that extra scope with a **Show available space** button —
   but the scope has to exist on the registration first, or that button returns
   an error.

## What a user does

1. Open Settings → Dropbox audio storage → Connect Dropbox. Allow the sign-in popup.
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
Recover missing sessions also reconstructs missing session records from
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

## One playable file per session

Segments are how the audio is *stored*; they are useless to anything that is not
FolkFriend. **Also save each finished session as one playable file** (in the
Dropbox panel, off by default) puts a complete recording in a flat
`/recordings` folder, named by date and session:

```text
/Apps/FolkFriend/recordings/2026-09-10 2108 The Cobblestone.m4a
```

Point any player at that folder and it works. Four things about it:

- **Only for a FINISHED session.** A live one's last track is still growing, so
  building the file now would mean re-uploading all of it on every new segment —
  hundreds of megabytes an hour, usually over mobile data.
- **One file per continuous stretch.** A pause, or a microphone the OS took
  away, starts a new track, and two tracks carry two container headers and
  cannot be joined. Those sessions save `… (part 2)` and so on.
- **It is a second copy**, so a session costs about twice the Dropbox space.
  That is the whole trade, and why it is opt-in.
- **Renaming a session MOVES the file**, it does not upload it again. The name
  is in the filename, so a rename changes it; re-uploading would cost the whole
  file and leave the old one orphaned under a name the user has just rejected.

Deleting the Dropbox copy removes this file too. It lives outside the session
folder, so that delete reaches two places — the paths are recorded in local
bookkeeping precisely so it can.

### Large uploads

`files/upload` is a single shot Dropbox caps at 150 MB, behind this client's
60 s deadline. A three-hour recording is **rejected outright above about
96 kbps**, and even at 64 kbps (86 MB) it needs ~11.5 Mbit/s sustained to land
inside the timeout. So whole recordings go through an upload session
(`upload_session/start` → `append_v2` → `finish`) in 8 MB pieces: each piece is
its own request with its own deadline, and a failure costs one piece rather than
the file. Dropbox computes the content hash over the assembled result, which is
verified exactly as a single-shot upload is.

## Storage usage in Settings

Dropbox audio storage shows bytes stored throughout the FolkFriend App Folder,
including audio and recovery JSON from all devices. It counts file metadata over
all recursive listing pages, without downloading recordings. Usage refreshes when
Settings opens, once a minute while visible, and on Refresh storage usage. Failed
refreshes retain the last reading with its check time and an error message.

Available account space is optional, and needs both halves: the app
registration must carry `account_info.read` (a one-time developer step — see
Deployment setup), and the user must then approve that extra scope with **Show
available space**. Without either, audio backup and the stored-byte count work
exactly as before; only the free-space figure is missing, and the panel says so.
The extra authorization still uses App Folder file access and grants no access
to files outside it. Account free space includes other Dropbox content; for
teams, the display respects both shared capacity and enforced member limits.
