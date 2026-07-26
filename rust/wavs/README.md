# Audio test fixtures

Short (~10 s) recordings used by the `audio_*` integration tests in
`rust/tests/integration_tests.rs` and by the benchmark corpus in
`rust/bench/tunes.json`.

**This directory is currently empty.** The original fixtures were destroyed and
have been removed pending re-recording — see below.

## Adding a recording

1. Drop the `.wav` in here. 16-bit PCM, mono or stereo, ~10 s is plenty (the
   search is tuned for about that length).
2. Add an entry to `rust/bench/tunes.json` with the expected tune IDs.
3. Add a test to `integration_tests.rs` calling `assert_audio_detects_one_of`.
   Tests whose WAV is missing skip themselves rather than failing, so a test can
   be committed before its clip exists.
4. **Verify the round-trip.** Commit, then clone the repo to a temp directory
   and check the file is byte-identical:

   ```sh
   git clone --depth 1 <repo> /tmp/check
   md5 /tmp/check/rust/wavs/your.wav rust/wavs/your.wav
   ```

   Step 4 is not paranoia — see below.

The app's Results page has a **"Save clip"** button that exports the last
manual recording as a WAV via the iOS share sheet, which is the easiest way to
capture a field recording that actually failed.

## Why the originals are gone

`.gitattributes` opens with `* text eol=lf`, which tells git every file is text.
`*.wav binary` was only added on 2026-05-31 (`b4a9e52`), but the fixtures were
committed on 2026-04-17 (`97a7c3f`). For those six weeks git ran its text filter
over the audio on commit, converting every CRLF to LF *inside the PCM data* and
storing the result.

The evidence: those files contained **zero `0D 0A` byte pairs** despite
thousands of lone `0D` bytes, where untouched binary of that size would have
10–30 by chance. Every one had been eaten.

It went unnoticed for months because while `text` was in effect git compared the
*filtered* working copy against the blob — so a pristine local file looked
identical to the mangled stored one and `git status` reported clean. The tests
passed only on the machine that created the files, and failed on any fresh
clone. Nothing in git's output told anyone.

The damage was real but partial: after repairing the headers the correct tune
still ranked 6th, 16th, 23rd, 39th and 54th out of ~62,000 settings for the
clips tested, with match scores at roughly 40–65% of their recorded baselines.
Recognisable, but well outside the thresholds the tests assert, so the corpus
was retired rather than re-baselined against damaged audio.

**The rule this leaves behind:** when introducing a new binary file type, add
its `*.ext binary` line to `.gitattributes` *in the same commit as the first
file of that type, or earlier*. The blanket `* text eol=lf` at the top will
silently corrupt it otherwise.
