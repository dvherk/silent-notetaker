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
documented in `testing.md`. Rust/Wasm builds, existing diarization tests, real
microphone-to-transcript behavior, on-device note generation, storage migration,
model quality, and mobile support still require the approved toolchain, models,
and suitable devices. `known-limitations.md` records the remaining gate.
