# Session workspace

Live listening and saved sessions use the same tune table. Use **Past sessions**
to search by session name, date or place and open one list at a time. Opening a
saved session does not stop background detection. **Current session** in the
global status bar returns to the listening session from any page.

- Sessions save automatically, including new empty sessions. Pause releases the
  microphone; Resume continues the same session. No Finish action is required.
- New session saves the previous session and begins a separate listening session.
  If the previous session cannot be saved, it stays available and no replacement
  starts. Sessions are retained until explicitly deleted; there is no automatic
  eviction at the former 300-session limit.
- Session actions → Clear tune list removes all entries but keeps the session's
  identity, date, name and listening time. It does not interrupt live capture.
- Session actions → Delete session removes the entire selected session after
  confirmation. Deleting the current session releases capture and waits for
  pending saves before deleting, so autosave cannot recreate it.
- The same table supports tune links, favourite stars, available alternative
  matches, individual removal and tune-list export for live and stored sessions.
  Old recordings without saved alternative matches still show their chosen tune.
- Names default to the date and matching named place when location tagging is
  enabled. No reverse-geocoding service is used. User-edited names override the
  automatic name. Stored coordinates can also match places named later.

Session records remain in the existing `liveSessions` store and backup/sync flow.
Optional `name`, `customName`, `placeName` and per-tune `alternatives` fields are
backward-compatible additions. Historical edits merge into the latest record
through the storage write queue, and refuse to recreate a deleted record.
Failures leave the edited list available with a Retry save action.

The last active session still has separate local resume state containing raw
analysis windows. Historical editing never replaces this state or feeds edits
into the ongoing detector. File analysis also keeps its own results and export
state.

Run `npm test` in `app` for service and component regressions. After a production
build, `npm run test:session-workspace` checks the rendered browser flow with an
isolated dataset and mobile viewport. Microphone interruption on physical devices
still requires separate device testing.
