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

Results on 2026-11-06:

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
- **Blocked:** Rust workspace tests, Wasm builds, and real browser persistence
  and speech tests. Windows Application Control blocked the pinned `cargo`
  executable with OS error 4551. No policy bypass was attempted.

The local-core increment is therefore **partial, not a completed Milestone 1**.
The full acceptance gate additionally requires an approved Rust toolchain, both
generated Wasm packages, Rust and browser tests with real IndexedDB fixtures,
and a real microphone-to-local-transcript and local-note-generation exercise.
Android and iOS validation require separate devices.

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
both afterward. It exercises only the capture module; model loading,
transcription, notes, and persistence are outside its scope.

For the remaining Rust and Wasm validation, follow `scripts/ci-local.sh` and
`scripts/build-wasm.sh` after an administrator supplies or authorizes a trusted
toolchain. The existing migration test's fixture-dependent case is a documented
skip, not proof of migration correctness.

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
- Provide a populated legacy IndexedDB migration fixture and assert the
  read/migrate/read-back result; the current fixture-dependent test is a skip.
  Test a fresh database and local write failures as well.
- Provide a real microphone, permission to capture test audio, and the required
  cached or downloadable model artifacts. Exercise microphone capture through
  local transcription and note generation, then repeat an appropriate
  full-application offline scenario. Synthetic capture alone is not that test.
