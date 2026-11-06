# Known limitations

## Milestone 1 local-core increment

The local-core changes add cleanup for failed capture setup and cancelled
permission prompts, recording-start rollback, stop handling when local writes
fail, visible transcript-write errors, retryable storage module initialization,
and explicit Claude bridge consent. Screenshot capture now honors its setting.
Regression tests exercise these paths with mocks. Existing speech and speaker
contracts and local note-generation code have not been replaced.

**Milestone 1 is not fully validated.** The Windows Application Control policy
blocked the pinned Rust executable with OS error 4551, so the generated Wasm
packages could not be built and the Rust suite, real IndexedDB operations,
microphone-to-transcript path, and on-device note generation could not be
tested. Use an organization-approved Rust toolchain, build both Wasm packages,
run the workspace and browser tests, and exercise capture and local notes on a
real device before declaring the milestone complete.

Additional outstanding limitations:

- IndexedDB content and temporary audio spools are not application-encrypted;
  retention, complete deletion, key management, and recovery need a design.
- Existing transcript rows lack a speaker ID; persistence of speaker-attributed
  history is not established. The legacy migration browser test needs a real
  fixture rather than its documented skip.
- Complete offline behavior, model download and inference, and Windows, Android,
  and iOS device support are not validated here.
- Model license flags remain unverified; see `current-state.md` and
  `research/model-licenses.md`. Microsoft identity, calendar, destinations, and
  Work IQ are later milestones, not implemented by this increment.
- Earlier bridge settings do not count as consent: users who want cloud
  processing must re-enable it in Settings after reading the disclosure.
  The bridge may send transcript text, notes, and screenshots to Claude; the
  current bridge path does not send raw audio.
- Automatic bridge-based speaker naming is disabled because it assigned inferred
  identities without confirmation. User-entered speaker renaming remains
  available; reviewed identity candidates are deferred to Milestone 3.

## Assessment scope

`current-state.md` is the historical Milestone 0 baseline, not a description of
the code after these changes. The validation evidence and remaining gate are
recorded in `testing.md`.
