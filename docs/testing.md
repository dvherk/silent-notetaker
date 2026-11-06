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
  This was not a microphone, model, or IndexedDB integration test.
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

For the remaining Rust and Wasm validation, follow `scripts/ci-local.sh` and
`scripts/build-wasm.sh` after an administrator supplies or authorizes a trusted
toolchain. The existing migration test's fixture-dependent case is a documented
skip, not proof of migration correctness.
