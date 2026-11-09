# Speech and speaker boundaries

This document records the current interfaces and gaps, not a claim that every
engine or platform has been validated.

## Capture to speech

`apps/web/js/capture.js` exposes `CaptureGraph`: start microphone capture,
receive `Float32Array` samples through a callback, optionally add tab audio,
and stop the graph. The requested `AudioContext` rate is 16 kHz and the worklet
delivers mono samples. The browser smoke in `testing.md` checks this rate and
stop/restart using a synthetic microphone, not a real device or an ASR model.
Queued samples from a stopped capture generation must not feed a later session.

`crates/silent-core/src/engine.rs` defines an async `AsrEngine` contract with
`id`, `capabilities`, `load`, `warm_up`, `feed`, `finalize`, `reset`, and
`stats`. `AudioChunk` represents 16 kHz mono samples with a start timestamp;
`EngineEvent` carries recognition events. This contract expresses the intended
boundary, but it does not prove that every shipping JavaScript engine implements
or is dispatched through it. The core's `AnyAsrEngine` is a placeholder;
`silent-inference` defines a separate concrete dispatch type for its JS host.

The actual browser orchestration in `index.html` uses engine-specific adapters:
for example, `nemotron-engine.js` exposes `load`, `feed`, `finalize`, and
`reset`, while `whisper-engine.js` has its own lifecycle. Do not remove or
replace those paths until a common adapter is wired to real engines and
regression-tested with the generated Wasm and actual models. No VibeVoice ASR
adapter or comparative benchmark is claimed here.

The Whisper adapter now waits for its model worker's ready event before the app
requests microphone access. Load failures and worker crashes surface as errors;
a stopped or failed startup can be retried. For solo Whisper/Moonshine, Stop
drains a speech-bearing partial chunk and waits for pending transcript callbacks
before final notes and summary, subject to a 120-second failure deadline.
Real-model and Dual-mode stop behavior remain unverified.

## Speaker processing

`diarization-engine.js` wraps the TitaNet embedding and Rust speaker tracker.
Its browser surface includes loading, `identify(samples)`, rename/merge
operations, and stop-time reclustering. Short segments may reuse the prior
speaker; that is an algorithmic heuristic, not verified identity. The
`DiarizationCommand` and `DiarizationEvent` types in
`crates/silent-core/src/diarization.rs` describe UI-facing speaker labels,
rename/merge decisions, and relabeling; they are not a complete interchangeable
speaker-provider interface.

Labels such as `S1` are anonymous, session-scoped clusters, not confirmed
people. User-entered renames remain available. Automatic bridge-based naming
was disabled because it applied an inferred identity without confirmation.
Candidate identities, evidence, uncertainty, sample review, and explicit
confirmation belong to Milestone 3 and are not implemented by this increment.
Existing transcript rows do not store speaker IDs, so stable attribution after
reload remains unverified.

## Validation and release gate

The JavaScript regression tests and synthetic-browser capture smoke are
documented in `testing.md`. Hosted Linux has built the Wasm packages and run the
existing Rust and browser tests, including synthetic storage fixtures. Real
microphone-to-transcript behavior, model inference and quality, full-app offline
behavior, representative legacy data, and mobile support remain unverified.
Local Rust execution still requires an administrator-approved toolchain.
`known-limitations.md` records the remaining gate.

The session, notes, storage, and diarization wrappers share one Wasm
initialization and permit a later retry after failure. The app retries a failed
session initialization when the user starts recording. If speaker model loading
fails for a meeting, it avoids retrying on every segment; a new meeting can try
again. These are recovery behaviors, not proof that model artifacts or speech
recognition work on a particular device.
