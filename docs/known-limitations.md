# Known limitations

## Milestone 1 local-core increment

The local-core changes add cleanup for failed capture setup and cancelled
permission prompts, recording-start rollback, stop handling when local writes
fail, visible transcript-write errors, retryable storage module initialization,
and explicit Claude bridge consent. Screenshot capture now honors its setting.
Regression tests exercise these paths with mocks. Existing speech and speaker
contracts and local note-generation code have not been replaced.

**Milestone 1 is not fully validated.** Hosted Linux built both Wasm packages
and exercised Rust and synthetic browser storage paths; Windows Application
Control still blocks local Rust execution with OS error 4551. The actual
microphone-to-transcript path, model inference, full-app offline behavior and
on-device end-to-end note generation remain unverified. The in-app legacy
backup/migration flow is also missing. See `testing.md` for exact runs and
remaining gates.

Additional outstanding limitations:

- IndexedDB content and temporary audio spools are not application-encrypted;
  retention, complete deletion, key management, and recovery need a design.
- Existing transcript rows lack a speaker ID; persistence of speaker-attributed
  history is not established. The older migration browser test's
  fixture-dependent case is a skip; the separate synthetic fixture tests a
  bounded set of legacy records, not all user data.
- The app does not invoke the available Wasm migration API or offer its backup.
  Its normal storage write upgrades a legacy database directly to v4. Do not
  assume an export was offered or saved, or infer universal zero-loss migration
  from the synthetic fixture.
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
