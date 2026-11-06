# Silent Notetaker

**Local-first meeting notes, with optional cloud processing.**

Silent Notetaker is a browser-based meeting notetaker designed to capture and
process audio locally. Its optional Claude bridge is off by default and, when
explicitly enabled, forwards transcript text, notes, and shared-tab screenshots
to Claude for cloud processing. See [the baseline assessment](docs/current-state.md)
and [known limitations](docs/known-limitations.md) for what has been verified.

> Top-5 Global Demo at AI Tinkerers.

**▶ Try it now: [silentnotetaker.com](https://silentnotetaker.com)** · nothing to install, runs entirely in your browser. Use Chrome or Edge; the first load downloads the models (a few hundred MB) into a browser-managed local cache, so give it a minute on the first visit. The browser may still evict that cache under storage pressure.

---

## Why

Every mainstream AI notetaker works the same way: it joins your call, **streams your audio to someone else's servers**, runs the AI there, and sends a summary back. The good ones are careful: encryption, SOC 2, "we delete the audio after transcription." Even the privacy-marketed ones (Granola, for example) still send your meeting to cloud LLMs and store it on their infrastructure. Their privacy is a **promise**, backed by a company.

The local capture path feeds audio to models in the browser. Model weights and
runtime scripts are downloaded, and an enforced `Content-Security-Policy` limits
browser connections. The optional Claude bridge is a separate cloud-processing
path: its local server forwards meeting content to Claude. Browser CSP does not
govern that server's outgoing connections.

There are whole categories of conversation (legal, medical, hiring, finance, M&A, journalism with sources) where "the audio left the building" is a non-starter. This is built for those.

---

## Features

- **Live transcription**: streaming speech-to-text as you talk.
- **Speaker identification**: labels each line by speaker (`S1`, `S2`, …) using on-device voice embeddings. Click any tag to rename a speaker; the name propagates everywhere.
- **Automatic note extraction**: sorts the conversation in real time into **Decisions**, **Action Items**, **Key Points**, and **Open Questions**.
- **Live meeting outline & smart questions**: a small on-device LLM builds an outline as you go and suggests a sharp question worth asking *right now*.
- **Slide / screen capture**: optionally grab tab audio and screenshots of shared slides.
- **Local-first storage**: meeting records are stored in the browser. They are not application-encrypted.
- **Clean export**: copy the whole meeting as structured Markdown.
- **Optional Claude bridge**: explicitly enable cloud processing in Settings and run `uv run bridge.py` separately. It can forward transcript text, notes, and screenshots to Claude; the bridge does not send audio. Existing users must opt in again because older versions enabled the bridge by default.

---

## How it works

The local pipeline runs client-side, in your browser:

<!-- credo-lint:allow-fenced pre-existing ASCII architecture diagram, mic icon labels the input node -->
```
  🎤 Microphone
       │
       ▼
  AudioWorklet @ 16 kHz mono
       │  Float32 PCM
       ├───────────────────────┬───────────────────────────┐
       ▼                       ▼                            ▼
  Nemotron ASR          TitaNet diarization        Qwen3 notes / outline
  (CPU / WASM,          (CPU / WASM,               (CPU / WASM live,
   streaming)            speaker embeddings)        WebGPU recap)
       │ text                  │ speaker id                 │
       └───────────┬───────────┘                           │
                   ▼                                        ▼
        Note extraction (Rust)  ───────────────▶  UI + local storage
                                                  (Rust/WASM, on-device)

  (optional)  ⇄  Claude bridge (local server)  ⇄  Claude cloud
```

The design splits work across silicon so nothing contends: the **default ASR (Nemotron streaming)** runs on **CPU/WASM**, which leaves the **GPU free for on-device Qwen** to generate notes and questions. Heavier engines like Voxtral take the GPU when selected. The application *policy* (engine selection, diarization, note triggers, question scheduling, storage, the recording state machine) is written in **Rust, compiled to WebAssembly**, driving a thin HTML/JS shell.

---

## Quickstart

**Requirements:** Chrome or Edge (most complete WebGPU support), a microphone, and a few hundred MB of free disk for the first-run model cache.

**Hosted app:** **[silentnotetaker.com](https://silentnotetaker.com)**. The page fetches runtime scripts and model weights; the optional bridge sends meeting content to Claude only after explicit opt-in. Model weights may be cached on-device in the browser's private file system (OPFS). Complete offline operation depends on all required assets being available and has not been validated in this assessment.

**Run it locally** (full source, same behavior):

```bash
git clone https://github.com/dvherk/silent-notetaker.git
cd silent-notetaker
./start.sh
```

`start.sh` launches a local server with the right headers and opens the app at **http://localhost:8080**. Pick an engine, click **Start**, allow the mic, and talk. The first run downloads the selected model from Hugging Face and may cache it on-device. The launcher does not start the optional Claude bridge.

> **Why a server and not just opening the file?** The on-device models use multithreaded WebAssembly, which the browser only enables when the page is "cross-origin isolated" (it needs `SharedArrayBuffer`). That requires two HTTP headers (`COOP` + `COEP`) you can't set from a `file://` URL. `start.sh` runs a tiny server that sends them: a Rust (axum) one if you have `cargo`, otherwise a dependency-free Python fallback (`coi-server.py`). A plain `python -m http.server` will *load* the app but run single-threaded and several times slower.

**Building the WebAssembly modules** (required for a fresh source checkout because generated packages are not committed):

```bash
./scripts/build-wasm.sh
```

The app is fully static and deploys to **Cloudflare Pages** (the `_headers` file carries the isolation + CSP headers). There is no backend to deploy.

---

## Architecture

The UI shell (markup, styles, engine loaders, the inlined transcription worker) lives in `index.html` and a handful of small ES modules (`nemotron-engine.js`, `diarization-engine.js`, `storage-engine.js`, …). The application *policy* lives in Rust crates under `crates/`, compiled to WebAssembly:

| Crate | Responsibility |
|---|---|
| `silent-core` | Shared contracts, session state machine, exporters |
| `nemotron-asr` | Cache-aware RNN-T streaming ASR (native + wasm32) |
| `silent-diarization` | TitaNet speaker embeddings + speaker tracking |
| `silent-notes` | Note trigger extraction + Qwen smart-question scheduling |
| `silent-storage` | On-device storage schema + migrations |
| `silent-inference` | JS-host dispatch plus bounded streaming/backlog policy |
| `silent-audio` | Audio chunking policy |
| `silent-extension-sdk` | Sandboxed extension permission model |
| `silent-web` | The wasm-bindgen boundary that exposes all of the above to the UI |

Each ES-module engine loader is a thin wrapper that delegates every policy decision to its corresponding wasm surface. Full design notes, the complete network trust boundary, and the roadmap are in **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)**.

The current speech and speaker boundaries, including adapter gaps, are described
in [`docs/speech-engines.md`](docs/speech-engines.md).

---

## Models

Everything runs client-side. The transcription engine is selectable in the UI.

| Role | Model | Runs on |
|---|---|---|
| Streaming ASR (default) | **Nemotron streaming 0.6B** (NVIDIA) | CPU / WASM |
| Streaming ASR (premium) | **Voxtral Realtime 4B** (Mistral) | WebGPU |
| Lightweight ASR | **SenseVoice** (FunAudioLLM), **Moonshine** (Useful Sensors) | WASM / WebGPU |
| ASR (familiar baseline) | **Whisper** large-v3-turbo / small / base (OpenAI) | WebGPU |
| Speaker embeddings | **TitaNet-small** (NVIDIA NeMo) | WASM (onnxruntime-web) |
| Notes & smart questions | **Qwen3** 0.6B / 1.7B (Alibaba) | WASM (live) + WebGPU (recap) |

Models are pulled from Hugging Face at runtime and cached locally.

---

## Tech stack

`Rust` · `WebAssembly` · `WebGPU` · `onnxruntime-web` · `Transformers.js` · `axum` · vanilla JS (no framework, no bundler) · Cloudflare Pages

---

## Privacy statement

The local speech path processes audio on-device. If Nemotron falls behind,
bounded PCM segments may temporarily enter the browser's origin-private local
storage. Model and runtime downloads require network access. The Claude bridge
is off by default and requires a fresh Settings opt-in; once enabled, transcript
text, notes, and screenshots can leave the device for Claude. Browser storage is
not application-encrypted. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for
the trust boundary and [`docs/known-limitations.md`](docs/known-limitations.md)
for unverified behavior.

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). The core notetaker (capture, transcription, speaker ID, note extraction, smart questions, local storage) is **free and stays free**, and the source stays auditable.

---

## Related

- [Brevity Meet](https://meet.brevity.ventures): Brevity's agentic meeting infrastructure.
- [brevity.ventures](https://brevity.ventures): what Brevity is building.

---

## License & credits

Code is [MIT](./LICENSE). Bundled and downloaded models retain their own upstream licenses. Models by NVIDIA, Mistral AI, OpenAI, Alibaba, FunAudioLLM, and Useful Sensors.

*Built by [Brevity Ventures](https://brevity.ventures). We build private, on-device AI.*
