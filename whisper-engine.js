/**
 * whisper-engine.js — Rust/WASM-driven Whisper-family + Moonshine streaming engine.
 *
 * The thin ES-module wrapper that REPLACES (strangler-fig) the inline
 * `transcription-worker-src` policy loop in index.html. The deterministic policy
 * — chunk buffering/splice, the VAD energy gate, the Whisper hallucination
 * filter, and tail-dedup — now lives in Rust as `WhisperStreamPolicy`
 * (crates/silent-inference), surfaced as `WasmWhisperStream` in the shared
 * `silent_web.js` pkg. This loader drives that policy and an executor worker that
 * runs ONLY `transcriber(audio)` (the transformers.js model). Same wasm binary,
 * same cross-loader init promise (`window.__silentWebModulePromises`) as the
 * other engine loaders.
 *
 * # What moved to Rust (the policy) vs what stays here (the executor)
 *
 *   Policy (Rust `WasmWhisperStream`):
 *     - chunk boundaries (buffer + splice CHUNK_SAMPLES, leftover stays buffered)
 *     - the VAD `hasSpeech` strided-RMS gate (silent chunks never reach the model)
 *     - the `isHallucination` filter (known Whisper junk + repeated-word loops)
 *     - tail-dedup (`deduplicateText`, DEDUP_WINDOW = 12)
 *     - the length guard + finalize semantics
 *
 *   Executor (this loader + a thin worker):
 *     - load the transformers.js ASR pipeline (host I/O; model download progress)
 *     - run `transcriber(audio)` on a chunk → raw decoded text (no policy)
 *     - capture 16 kHz mono mic samples (host execution)
 *     - word corrections: applied here on the emitted final (the SAME Rust
 *       `WasmCorrections` the inline worker used, composed downstream of dedup —
 *       exactly where the JS applied them, after dedup, before render)
 *
 * # Final-only, by design
 *
 * The transformers.js loop emits only finals (the chunk is the unit). So this
 * engine surfaces `onFinal` (and `onStatus`/progress); `onPartial` is unused for
 * solo Whisper/Moonshine (Dual mode re-labels Moonshine finals as drafts via the
 * Dual coordinator — see dual-engine.js, not here).
 *
 * # The executor worker
 *
 * A minimal module worker built from a blob: it loads the transformers.js
 * pipeline and replies with the raw decoded text per chunk. It carries NO policy
 * (no VAD, no hallucination filter, no dedup) — those are Rust. This is the
 * "byte-for-byte port; your job is the plumbing" split: the worker is the model
 * executor, the policy is `WasmWhisperStream`.
 */

import { loadSilentWebModule } from './silent-web-loader.js';

const DEFAULT_PKG_URL = new URL('./crates/silent-web/pkg/silent_web.js', import.meta.url).href;

// The executor worker source now lives in the permanent transformers-host.js
// module so any future js-transformers host can share it. Re-exported here
// for backward compatibility with callers that depend on this engine file.
import { EXECUTOR_WORKER_SRC } from './apps/web/js/transformers-host.js';

export class WhisperEngine {
  /**
   * @param {object} [opts]
   * @param {string}  [opts.pkgUrl]    wasm-pack pkg URL override.
   * @param {boolean} [opts.dualLeg]   true → Moonshine-in-Dual cadence (3 s chunks).
   */
  constructor(opts = {}) {
    const w = (typeof window !== 'undefined') ? window : {};
    this.pkgUrl = opts.pkgUrl || w.__SILENT_WEB_PKG_URL || w.__DIARIZATION_PKG_URL || DEFAULT_PKG_URL;
    this.dualLeg = !!opts.dualLeg;

    // Callbacks (same shapes index.html's TranscriptionManager consumes).
    this.onPartial = null;   // (text) => void  — unused solo (final-only loop)
    this.onFinal   = null;   // (text) => void
    this.onStatus  = null;   // (message|null, pct|null) => void

    this._mod = null;
    this._policy = null;       // WasmWhisperStream
    this._corrections = null;  // WasmCorrections (composed downstream of dedup)
    this._worker = null;
    this._workerUrl = null;
    this._loadPromise = null;
    this._loadGeneration = 0;
    this._cancelLoad = null;
    this._initResolve = null;
    this._initReject = null;
    this.ready = false;
    // Pending chunk spans, keyed by chunk index, so a decoded reply can be
    // range-stamped with the exact span the policy issued the command for.
    this._spans = new Map();
    // The policy owns chunk BOUNDARIES (it buffers counts + decides VAD-skip);
    // the host owns the SAMPLES. The mirror is that host-side sample buffer, keyed
    // by absolute sample position so a `transcribe` command's `start_ms` resolves
    // to the exact chunk audio — even past VAD-skipped silent chunks (their span
    // is simply never referenced by a command, so it is dropped on the next slice).
    this._mirror = new Float32Array(0);
    this._mirrorBaseAbs = 0;   // absolute sample index of mirror[0]
    // Chunk size in samples (5 s solo, 3 s Moonshine-in-Dual) — matches the Rust
    // policy config so the host slice length is identical.
    this._chunkSamples = 16000 * (opts.dualLeg ? 3 : 5);
  }

  /** Load the Wasm policy and wait for the worker's model-ready event. */
  load(config = {}) {
    if (this._loadPromise) return this._loadPromise;
    const generation = ++this._loadGeneration;
    const cancellation = new Promise((_, reject) => { this._cancelLoad = reject; });
    const operation = (async () => {
      const mod = await loadSilentWebModule(this.pkgUrl);
      if (generation !== this._loadGeneration) throw new Error('Whisper initialization cancelled');
      this._mod = mod;
      const { WasmWhisperStream, WasmCorrections } = this._mod;
      this._policy = this.dualLeg ? WasmWhisperStream.moonshineDual() : new WasmWhisperStream();
      this._corrections = new WasmCorrections();

      // Spawn the executor worker (model + raw transcribe only).
      this._workerUrl = URL.createObjectURL(new Blob([EXECUTOR_WORKER_SRC], { type: 'application/javascript' }));
      const worker = this._worker = new Worker(this._workerUrl, { type: 'module' });
      worker.onmessage = event => {
        if (this._worker === worker) this._onWorkerMessage(event.data);
      };
      worker.onerror = event => {
        if (this._worker !== worker) return;
        event.preventDefault();
        this._onWorkerError(event.message || 'Transcription worker failed', true);
      };
      worker.onmessageerror = () => {
        if (this._worker === worker) this._onWorkerError('Transcription worker message could not be decoded', true);
      };
      await new Promise((resolve, reject) => {
        this._initResolve = resolve;
        this._initReject = reject;
        try {
          if (config.model) {
            worker.postMessage({ type: 'configure', config: {
              model: config.model,
              dtype: config.dtype || 'fp32',
              device: config.device || 'wasm',
              language: config.language || 'en',
            }});
          }
          worker.postMessage({ type: 'init' });
        } catch (error) {
          this._initResolve = null;
          this._initReject = null;
          reject(error);
        }
      });
      if (generation !== this._loadGeneration) throw new Error('Whisper initialization cancelled');
      this._cancelLoad = null;
      this.ready = true;
      console.log(`[rust-whisper] WhisperEngine ready (Rust policy: chunk/VAD/hallucination/dedup; worker = model executor${this.dualLeg ? '; Moonshine-Dual 3s cadence' : ''})`);
    })();
    this._loadPromise = Promise.race([operation, cancellation]).catch(error => {
      if (generation === this._loadGeneration) {
        try {
          this._teardown();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Whisper initialization and cleanup failed');
        }
      }
      throw error;
    });
    return this._loadPromise;
  }

  /** Set the word-corrections map (JSON array of {wrong, right}), applied post-dedup. */
  setCorrections(pairs) {
    if (this._corrections) this._corrections.set(JSON.stringify(pairs || []));
  }

  /**
   * Feed captured 16 kHz mono samples. Drives the Rust policy: every ready,
   * speech-bearing chunk yields a `transcribe` command posted to the worker.
   * @param {Float32Array} samples
   */
  feed(samples) {
    if (!this.ready || !this._policy || !samples || !samples.length) return;
    // Append to the host-side sample mirror (the policy gets the same samples).
    this._appendMirror(samples);
    const cmds = JSON.parse(this._policy.pushSamples(samples));
    for (const cmd of cmds) {
      if (cmd.cmd === 'transcribe') {
        // The policy stamped this chunk's span in ms; resolve it to absolute
        // sample offsets and slice the exact chunk audio out of the mirror.
        const audio = this._sliceChunk(cmd.start_ms);
        if (!audio) continue;   // mirror desync guard (should not happen)
        this._spans.set(cmd.chunk, { start_ms: cmd.start_ms, end_ms: cmd.end_ms });
        this._worker.postMessage({ type: 'transcribe', chunk: cmd.chunk, audio }, [audio.buffer]);
      }
    }
  }

  /** Append samples to the absolute-positioned host mirror. */
  _appendMirror(samples) {
    const merged = new Float32Array(this._mirror.length + samples.length);
    merged.set(this._mirror, 0);
    merged.set(samples, this._mirror.length);
    this._mirror = merged;
  }

  /**
   * Slice the chunk whose first sample is at `start_ms` (the policy's command
   * span) out of the absolute-positioned mirror, dropping everything before it
   * (any preceding VAD-skipped silent chunk audio the policy already consumed).
   * @returns {Float32Array|null}
   */
  _sliceChunk(startMs) {
    const startAbs = Math.round(startMs * 16000 / 1000);
    const n = this._chunkSamples;
    const offset = startAbs - this._mirrorBaseAbs;
    if (offset < 0 || offset + n > this._mirror.length) return null;
    const out = Float32Array.from(this._mirror.subarray(offset, offset + n));
    // Advance the mirror base past this chunk; drop the consumed prefix.
    const consumed = offset + n;
    this._mirror = this._mirror.subarray(consumed);
    this._mirrorBaseAbs += consumed;
    return out;
  }

  /** Request stop: drain the worker, terminate, finalize the policy. */
  async stop() {
    const errors = [];
    try {
      if (this._policy) {
        this._policy.requestStop();
        const fin = JSON.parse(this._policy.drainFinalize());
        if (fin && fin.cmd === 'finalize') this._worker?.postMessage({ type: 'terminate' });
      }
    } catch (error) {
      errors.push(error);
    }
    try { this._teardown(); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Whisper stop and cleanup failed');
  }

  reset() {
    this._policy?.reset();
    this._spans.clear();
    this._mirror = new Float32Array(0);
    this._mirrorBaseAbs = 0;
  }

  _onWorkerMessage(data) {
    const { type } = data;
    if (type === 'partial') { this.onPartial?.(data.text); return; }
    if (type === 'status')  { this.onStatus?.(data.message, null); return; }
    if (type === 'progress'){ this.onStatus?.(null, data.value); return; }
    if (type === 'ready') {
      const resolve = this._initResolve;
      this._initResolve = null;
      this._initReject = null;
      resolve?.();
      this.onStatus?.(this.dualLeg ? 'Moonshine ready, loading SenseVoice...' : 'Moonshine ready — fully local', this.dualLeg ? 30 : 100);
      return;
    }
    if (type === 'error') { this._onWorkerError(data.message); return; }
    if (type === 'decoded') {
      // Run the decoded text back through the Rust policy (hallucination + dedup).
      const span = this._spans.get(data.chunk) || { start_ms: 0, end_ms: 0 };
      this._spans.delete(data.chunk);
      const events = JSON.parse(this._policy.onDecoded(data.text || '', span.start_ms, span.end_ms));
      for (const ev of events) {
        if (ev.tag === 'final') {
          // Corrections compose downstream of dedup — exactly where the JS worker
          // applied them (after dedup, before emit).
          const corrected = this._corrections ? this._corrections.apply(ev.payload.text) : ev.payload.text;
          if (corrected && corrected.trim()) this.onFinal?.(corrected.trim());
        } else if (ev.tag === 'partial') {
          this.onPartial?.(ev.payload.text);
        }
      }
    }
  }

  _onWorkerError(message, fatal = false) {
    const reject = this._initReject;
    this._initResolve = null;
    this._initReject = null;
    if (reject) reject(new Error(message || 'Transcription worker failed'));
    else {
      if (fatal) {
        try {
          this._teardown();
        } catch (cleanupError) {
          console.error('[rust-whisper] worker cleanup failed:', cleanupError);
          this.onStatus?.('Error: ' + (message || 'Transcription worker failed') + '; cleanup failed', null);
          return;
        }
      }
      this.onStatus?.('Error: ' + (message || 'Transcription worker failed'), null);
    }
  }

  _teardown() {
    this._loadGeneration++;
    const cancel = this._cancelLoad;
    this._cancelLoad = null;
    cancel?.(new Error('Whisper initialization cancelled'));
    const reject = this._initReject;
    this._initResolve = null;
    this._initReject = null;
    reject?.(new Error('Whisper initialization cancelled'));
    const worker = this._worker;
    const workerUrl = this._workerUrl;
    const policy = this._policy;
    const corrections = this._corrections;
    this._worker = null;
    this._workerUrl = null;
    this._policy = null;
    this._corrections = null;
    this._loadPromise = null;
    this._spans.clear();
    this._mirror = new Float32Array(0);
    this._mirrorBaseAbs = 0;
    this.ready = false;
    const errors = [];
    try { worker?.terminate(); } catch (error) { errors.push(error); }
    try { if (workerUrl) URL.revokeObjectURL(workerUrl); } catch (error) { errors.push(error); }
    for (const resource of [policy, corrections]) {
      try { resource?.free?.(); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Whisper cleanup failed');
  }
}

export default WhisperEngine;
