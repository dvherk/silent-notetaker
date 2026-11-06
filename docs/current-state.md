# Milestone 0: baseline assessment

Assessment of fork `dvherk/silent-notetaker` at commit `7d9a2f3`, 2026-11-05.
The initial worktree was clean. This report distinguishes observed results from
source-level claims; no architectural changes were made for the assessment.

## 1. Current architecture

- `index.html` orchestrates the browser UI, capture, engine loading, notes,
  speakers, history, and optional bridge. Root-level `*-engine.js` modules bridge
  into Rust/Wasm; `apps/web/js/` contains browser capture, runtime loading, model
  caching, audio spooling, and bridge executors.
- The Rust workspace has separate crates for contracts and session policy,
  audio, inference policy, diarization, notes, IndexedDB storage, extension
  permissions, and the Wasm boundary. `nemotron-asr` implements streaming ASR.
  The separate `server/` crate and Python fallback serve the static app.
- The intended capture path is microphone/AudioWorklet to local ASR and
  diarization, then transcript and notes in IndexedDB. Model weights and some
  runtime code are downloaded. The optional local Claude bridge can forward
  transcript text and screenshots to a remote Claude backend.
- The source contains an async `AsrEngine` contract and typed diarization
  commands/events; not every runtime is demonstrated to use one interchangeable
  lifecycle interface. Speaker labels are not biometric identity verification.

## 2. Verified working capabilities

The Python fallback server returned HTTP 200 for the app shell with
`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy:
require-corp`, and an enforced content security policy. Headless Microsoft Edge
requested the page and several JavaScript modules from that server. This proves
only that the shell was served and requested, not that the app is operational.
The JavaScript tests listed below passed.

The source implements paths intended for microphone and tab capture, several
local ASR engines, speaker tracking and rename/merge, local note extraction,
Markdown export, and IndexedDB meeting history. These capabilities are
**unverified here**, not established working capabilities.

## 3. Failed or unverified capabilities

- The generated Wasm packages under `crates/silent-web/pkg` and
  `crates/nemotron-asr/pkg` are absent in this worktree; the server returned
  HTTP 404 for `crates/silent-web/pkg/silent_web.js`. They must be built before
  testing the local app fully.
- Microphone permissions, live capture, stop/continue, model downloads, ASR
  accuracy, speaker consistency, note generation, IndexedDB CRUD/migration,
  exports, offline operation, and bridge behavior have not been exercised.
  Existing research results and checked-in screenshots are historical evidence,
  not validation of this checkout.
- Source paths for Microsoft sign-in, Graph calendar, Dynamics, OneNote,
  Work IQ, native mobile packaging, and enterprise consent/review flows were not
  found during this assessment; none is claimed to work.
- Source inspection suggests capture-start failures can leave the session
  machine in `Recording` and a meeting row behind: `App.start()` advances the
  machine and creates a row before capture succeeds, while its catch block does
  not reset either. `CaptureGraph.addSystemAudio()` starts screenshot capture
  before checking for an audio track and throws without cleaning up on the
  no-audio path. Reproduce and test both before changing them.
- `add_transcript_chunk` persists text and timestamp but no speaker ID. Durable
  per-meeting speaker names do not by themselves prove speaker-attributed
  history survives reload.

## 4. Existing test results

| Check | Result in this assessment |
|---|---|
| `node --test tests\final-notes-policy.test.mjs .evals\MeetingNotesQuality\score-output.test.mjs .rubrics\CanonicalMeetingNotes\verifiers\held-out.test.mjs` | **Passed:** 26 tests, 0 failures, Node v26.13.0. |
| `cargo test --workspace --all-targets` | **Not run:** `cargo` was not on PATH. An isolated installation of pinned Rust 1.95.0 was attempted; launching its `cargo` failed with `An Application Control policy has blocked this file. (os error 4551)`. |
| Local app | Python 3.14.10 served the shell; headless Edge requested the page and modules. Required generated Wasm loader returned 404, so recording was not tested. |
| Wasm build, browser Wasm tests, dependency scans | **Not run:** blocked by the Rust executable policy; no real microphone/device test was performed. |

The repository includes Rust unit/golden tests, JavaScript note-policy/evaluation
tests, and browser-targeted tests. CI declares format, check, native tests,
Clippy, cargo-deny/audit, browser Wasm smoke, and generated-header/model gates;
their presence is not a result. In particular,
`crates/silent-storage/tests/browser_idb.rs` explicitly skips asserting its
legacy migration round-trip without a fixture, and the CI browser smoke path
shown targets the Nemotron crate rather than proving the whole app.

## 5. Platform limitations

The project is a browser application, not a verified Windows, Android, or iOS
native app. Windows microphone, Chrome/Edge WebGPU, isolation behavior and
performance were not tested. Android and iOS capture, background behavior,
memory limits, offline loading, and share-sheet ingestion remain unverified.
The scripts are Bash-oriented; `start.sh` also uses `lsof`, so its documented
launcher cannot be assumed to work in native Windows PowerShell. A real device
and browser matrix is required. Offline use cannot be inferred merely from
cached weights because runtime scripts and first-run assets are also needed.

## 6. Licensing and dependencies

The root `LICENSE` grants MIT terms for repository code and says models have
their own licenses; the workspace package metadata says `MIT OR Apache-2.0`,
and `nemotron-asr` contains both license texts. Resolve the scope of that
metadata discrepancy before redistribution; this assessment is not legal advice.
The root license mentions a bundled `titanet.onnx`, but no such tracked file was
found; `registry/models.toml` describes runtime downloads.

Every model registry entry currently has `license_verified = false`. The
existing `docs/research/model-licenses.md` identifies attribution/notice
requirements, conditional Qwen conversion checks, and unresolved SenseVoice
commercial-language questions. Its conclusions have not been independently
verified in this assessment. Obtain legal review and verify the exact model
revisions, conversions, and notices before redistribution or commercial use.
`Cargo.lock`, `server/Cargo.lock`, and `eval/js/package-lock.json` record
dependencies; `bridge.py` declares minimum-version Python dependencies.
`deny.toml` documents an exception for unmaintained `derivative`
(`RUSTSEC-2024-0388`). Dependency and license scans were not run.

## 7. Security and privacy findings

- **Privacy disclosure conflict:** `index.html` defaults `claudeBridge` to
  true and attempts to auto-connect when a bridge is available; transcript
  chunks and, when enabled, screenshots are sent to it. `bridge.py` forwards
  content to Claude via its CLI or Anthropic API. The bridge panel says data
  never leaves the machine, and README/architecture statements imply a stronger
  local-only guarantee than this code supports. `start.sh` attempts to start the
  bridge automatically if `uv` is present. Do not use the bridge for private
  meetings until an explicit, accurately disclosed opt-in is implemented and
  verified.
- IndexedDB records contain meeting text, notes and screenshots without an
  application-level encryption design; browser profile/OS protections are not
  equivalent to encrypted local storage. Temporary audio may be spooled to
  OPFS. Retention, complete deletion, backups, and device theft need review.
- `_headers` and the Python server define an enforced CSP and cross-origin
  isolation, but allowed remote runtime scripts, `unsafe-inline`, localhost
  bridge access, extensions, and the server's actual binding remain part of
  the trust boundary. CSP alone does not establish that all data stays local.
- Prompt-injection handling, consent, biometric retention, data deletion,
  XSS resistance, secrets/dependency scanning, and external-write auditing were
  not validated. This is a risk assessment, not an exhaustive security review.

## 8. Recommended changes

1. Establish an actual runnable baseline and preserve existing data before any
   migration; use real browser IndexedDB fixtures and a test microphone.
2. Make remote processing explicitly opt-in with accurate, visible disclosure;
   preserve existing settings intentionally and test that private mode cannot
   auto-connect or transmit content.
3. Repair capture startup/cleanup and stop/resume error handling based on
   reproduced failures; surface storage failures without silently losing data.
4. Reuse existing speech and speaker contracts, then add narrow, tested
   lifecycle boundaries around real adapters rather than introducing a
   parallel mock-only pipeline. Test persisted speaker attribution and
   local-note behavior before changing the schema.
5. Address encryption, retention, deletion, and model/dependency license review
   in explicit increments; correct stale privacy and platform claims.

## 9. Milestone plan and gates

| Milestone | Objective and acceptance gate |
|---|---|
| 0 | This report records the architecture, evidence, limitations and test attempts. **Open:** allow a trusted Rust toolchain, build both Wasm packages, run remaining suites and exercise a real recording; record actual results. Commit this truthful baseline without claiming those checks passed. |
| 1 | Stabilize capture and local persistence with failure/cleanup and stop/resume regression tests; preserve and exercise existing local transcription and note generation; define practical speech/speaker boundaries; document remaining limitations. Require targeted automated tests, browser persistence/capture validation where feasible, and a clean commit. |
| 2 | Optional Entra/PKCE and bounded calendar suggestions, with incremental permissions, consent, tests and no impact on local capture. Not started. |
| 3 | Anonymous speaker identity candidates, evidence, explicit confirmation and correction. |
| 4 | Explicitly reviewed OneNote and Dynamics destinations with auditing and offline/failure handling. |
| 5 | Optional, disclosed post-capture Work IQ enrichment. |
| 6 | Experimental VibeVoice ASR adapters and reproducible comparative benchmarks; retain existing engine until objective gates pass. |
| 7 | Real Windows, Android and iOS packaging, offline and device validation. |

Each milestone needs documented acceptance criteria, tests, known limitations,
and a clean commit before advancing. Milestone 1 must not be presented as
validated without running its tests and preserving the working local path.

## 10. Risks, dependencies and open decisions

- **Toolchain blocker:** Windows Application Control blocked the isolated
  `cargo` executable with OS error 4551. Use an organization-approved Rust
  installation or have an administrator authorize the executable; do not
  bypass the policy. Then build both Wasm packages and rerun Rust/browser tests.
- Local-first security requires an explicit design for key management,
  encryption, retention and recovery. Do not invent a security guarantee from
  IndexedDB storage.
- Confirm model redistribution/commercial terms and notices with an appropriate
  reviewer. Avoid changing model selection or licensing position by assumption.
- Obtain appropriate Microsoft tenant/app registration and test accounts for
  later milestones, plus Windows, Android and iOS devices and representative
  audio for platform and model quality testing. These are pending, not passed.
- Decide the product's consent/recording-notice policy and applicable retention
  requirements before persisting biometric voice identities or enabling
  external processing. Calendar invitees must never be treated as confirmed
  attendees or speakers.
