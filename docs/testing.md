# Validation

## Milestone 1 local-core increment

Acceptance criteria for this increment:

1. Failed capture startup releases acquired resources and restores a non-recording
   session; cancelling pending permissions does not revive recording.
2. Stop tears down capture even if a local note or meeting write fails, and
   transcript-write failures are visible rather than reported as committed.
3. Existing local speech/note paths remain in place; speaker identities are not
   inferred and applied automatically.
4. The Claude bridge cannot connect or transmit without a fresh, disclosed
   opt-in, including for previously saved settings.
5. Automated regression tests cover the above and existing JavaScript note
   behavior; browser, Wasm, storage and device limitations remain explicit.

Local results on 2026-11-06, with later hosted checks below:

- **Passed:** 48 Node.js tests, including the existing notes tests and mocked
  local-core regressions, with Node v26.13.0. CI runs these suites on Node 24.
- **Passed:** headless Edge loaded the local shell with cross-origin isolation.
  In that browser, the settings disclosure and fresh/legacy consent behavior
  were checked, and a mocked shared-screen stream without audio was stopped.
  A separate browser smoke test used Edge's synthetic microphone and real
  AudioWorklet to deliver 16 kHz samples, stop, and restart after network
  connectivity was simulated as offline. This was not a physical microphone,
  model, full-app offline, or IndexedDB integration test.
- **Passed:** JavaScript module and inline-script syntax checks, `bash -n
  start.sh`, and `git diff --check`.
- **Blocked locally:** Windows Application Control blocked the pinned `cargo`
  executable with OS error 4551. No policy bypass was attempted.

Hosted Linux and local browser evidence:

- [Run 42585275292](https://github.com/dvherk/silent-notetaker/actions/runs/42585275292)
  passed the Rust workspace checks, tests and Clippy; JavaScript tests; browser
  Wasm tests; boundary and xtask gates; and dependency checks. Its new synthetic
  IndexedDB fixture timed out opening the upgraded database, so the overall
  Wasm integration gate failed.
- [Run 42586157800](https://github.com/dvherk/silent-notetaker/actions/runs/42586157800)
  built both Wasm packages twice with byte-identical results. Its synthetic
  migration, backup readback, local trigger-note generation, and reload passed
  after fixing the connection lifetime. Browser Wasm and standalone server
  tests also passed. The overall run failed at `cargo fmt --all --check` due to
  import ordering; dependent Rust gates were skipped in that run. The server
  audit reported an allowed Tokio unsoundness warning; the generated targeted
  lockfile update was verified in the next run.
- **Passed:** [Run 42587003743](https://github.com/dvherk/silent-notetaker/actions/runs/42587003743)
  on commit `ac8bf4e` completed all hosted jobs: Rust format, workspace check,
  tests and Clippy; JavaScript and browser Wasm tests; boundary and xtask gates;
  standalone server tests and audit; workspace dependency checks; two
  byte-identical Wasm builds; and the strengthened synthetic storage fixture.
  The workspace audit retained the documented pre-existing unmaintained
  `derivative` warning, RUSTSEC-2024-0388. No model or real microphone was used.
- **Passed locally:** 49 Node tests and headless Edge using the hosted
  `silent-web` package with a synthetic Dexie-v2 fixture. The fixture checks
  migration and backup event ordering, screenshot encodings and bytes, repeat
  migration, writes through `StorageEngine`, local trigger-note generation and
  persistence after reload. A separate direct legacy-to-v4 write through that
  adapter preserves the synthetic records but does not invoke backup. These
  tests do not establish preservation for every existing user database. A fresh
  database fixture also checks local CRUD and speaker-name maps, rejects a write
  to a missing meeting, and continues writing afterward; it does not simulate
  quota, permission, or device failures.

The local-core increment is therefore **partial, not a completed Milestone 1**.
The full acceptance gate still requires a verified in-app backup/migration path,
an approved local Rust toolchain for local development, and a real
microphone-to-local-transcript and local-note-generation exercise. Full-app
offline behavior is unverified. Android and iOS validation require separate
devices.

Run the JavaScript suites from PowerShell:

```powershell
$tests = Get-ChildItem 'tests\*.test.mjs' | ForEach-Object { $_.FullName }
node --test $tests .evals\MeetingNotesQuality\score-output.test.mjs .rubrics\CanonicalMeetingNotes\verifiers\held-out.test.mjs
```

Run the optional browser capture smoke using an installed Chrome or Edge:

```powershell
$env:SILENT_BROWSER_BIN = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
node scripts\browser-capture-smoke.mjs
```

The harness starts a temporary loopback server and isolated browser profile,
uses the browser's fake-media flags rather than a physical microphone, and closes
both afterward. By default it exercises only capture. To additionally exercise
the synthetic storage fixture with an already-built `silent-web` package:

```powershell
$env:SILENT_STORAGE_WASM_SMOKE = '1'
$env:SILENT_WEB_PKG_DIR = '<path to silent-web package directory>'
node scripts\browser-capture-smoke.mjs
```

The fixture directly calls the Wasm migration API; the application does not
call it or offer its emitted backup. It also checks the separate, direct
upgrade used by the storage adapter. Neither path tests real audio, a model, or
the complete application.

The migration API is not an end-user recovery flow: its typed backup omits
unrecognized record fields, no importer is provided, and concurrent edits in
other tabs are not coordinated. The regression fixture checks preservation of
an additional synthetic screenshot property in the database itself.

For local Rust and Wasm validation, follow `scripts/ci-local.sh` and
`scripts/build-wasm.sh` after an administrator supplies or authorizes a trusted
toolchain. The older `browser_idb.rs` fixture-dependent test is a documented
skip, not migration proof; the separate synthetic fixture above supplies bounded
browser evidence.

### Approved environment required to finish Milestone 1

- An administrator must provide or authorize the Rust toolchain executables
  under the organization's Windows Application Control policy. The repository
  pins Rust 1.95.0, `rustfmt`, `clippy`, `rust-src`, and the
  `wasm32-unknown-unknown` target in `rust-toolchain.toml`; a trusted
  `wasm-pack` 0.13.1 and the Visual C++ build tools are also needed. The
  administrator may need to authorize additional toolchain or build-generated
  executables. Do not disable or work around the policy.
- Build `crates/silent-web` and `crates/nemotron-asr` Wasm packages using
  `scripts/build-wasm.sh` in a supported Bash environment, then run the
  workspace tests and browser Wasm tests with a matching Chrome/ChromeDriver.
  The existing shell scripts assume Unix-style tools and are not demonstrated
  to work unchanged in native Windows PowerShell.
- Implement and verify an in-app migration and user-accessible backup flow before
  relying on it for legacy data. The current app opens the legacy database at
  v4 on a normal write without invoking the migration API or offering a backup.
  Exercise representative user-approved legacy fixtures and additional local
  write failures, including quota and permission failures.
- Provide a real microphone, permission to capture test audio, and the required
  cached or downloadable model artifacts. Exercise microphone capture through
  local transcription and note generation, then repeat an appropriate
  full-application offline scenario. Synthetic capture alone is not that test.
