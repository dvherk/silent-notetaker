import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { WhisperEngine } from '../whisper-engine.js';

function harness(t) {
  const previousCache = globalThis.__silentWebModulePromises;
  const previousWorker = globalThis.Worker;
  const cache = new Map();
  globalThis.__silentWebModulePromises = cache;
  const workers = [];
  globalThis.Worker = class {
    constructor() { workers.push(this); this.messages = []; this.terminated = false; }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
    emit(data) { this.onmessage?.({ data }); }
    fail(message) { this.onerror?.({ message, preventDefault() {} }); }
  };
  t.after(() => {
    if (previousCache === undefined) delete globalThis.__silentWebModulePromises;
    else globalThis.__silentWebModulePromises = previousCache;
    if (previousWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = previousWorker;
  });
  const url = 'test:whisper-startup';
  cache.set(url, Promise.resolve({
    WasmWhisperStream: class {
      requestStop() {}
      drainFinalize() { return 'null'; }
      free() {}
    },
    WasmCorrections: class { free() {} },
  }));
  return { engine: new WhisperEngine({ pkgUrl: url }), workers, cache, url };
}

async function waitForWorker(workers) {
  for (let attempt = 0; attempt < 20 && workers.length === 0; attempt++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(workers.length > 0, 'worker was not created');
  return workers.at(-1);
}

test('Whisper startup waits for the model worker to report ready', async t => {
  const { engine, workers } = harness(t);
  let settled = false;
  const loading = engine.load({ model: 'synthetic/model' }).then(() => { settled = true; });
  const worker = await waitForWorker(workers);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(engine.ready, false);
  assert.deepEqual(worker.messages.map(message => message.type), ['configure', 'init']);
  worker.emit({ type: 'ready' });
  await loading;
  assert.equal(engine.ready, true);
  await engine.stop();
});

test('model load errors reject startup, clean up, and allow retry', async t => {
  const { engine, workers } = harness(t);
  const first = engine.load();
  const worker = await waitForWorker(workers);
  worker.emit({ type: 'error', message: 'synthetic model failure' });
  await assert.rejects(first, /synthetic model failure/);
  assert.equal(engine.ready, false);
  assert.equal(worker.terminated, true);
  const second = engine.load();
  while (workers.length < 2) await new Promise(resolve => setImmediate(resolve));
  workers[1].emit({ type: 'ready' });
  await second;
  assert.equal(engine.ready, true);
  await engine.stop();
});

test('worker startup crashes reject instead of reporting a ready engine', async t => {
  const { engine, workers } = harness(t);
  const loading = engine.load();
  const worker = await waitForWorker(workers);
  worker.fail('synthetic worker crash');
  await assert.rejects(loading, /synthetic worker crash/);
  assert.equal(engine.ready, false);
  assert.equal(worker.terminated, true);
});

test('a fatal worker error after startup is visible and permits a later retry', async t => {
  const { engine, workers } = harness(t);
  const messages = [];
  engine.onStatus = message => { if (message) messages.push(message); };
  const loading = engine.load();
  const first = await waitForWorker(workers);
  first.emit({ type: 'ready' });
  await loading;
  engine._mirror = new Float32Array([1, 2]);
  engine._mirrorBaseAbs = 20;
  engine._spans.set(1, { start_ms: 0, end_ms: 1 });
  first.fail('synthetic runtime crash');
  assert.equal(engine.ready, false);
  assert.equal(first.terminated, true);
  assert.equal(engine._mirror.length, 0);
  assert.equal(engine._mirrorBaseAbs, 0);
  assert.equal(engine._spans.size, 0);
  assert.match(messages.at(-1), /synthetic runtime crash/);
  const retry = engine.load();
  while (workers.length < 2) await new Promise(resolve => setImmediate(resolve));
  workers[1].emit({ type: 'ready' });
  await retry;
  assert.equal(engine.ready, true);
  await engine.stop();
});

test('stopping during model loading rejects the pending initialization', async t => {
  const { engine, workers } = harness(t);
  const loading = engine.load();
  const rejected = assert.rejects(loading, /cancel/i);
  const worker = await waitForWorker(workers);
  await engine.stop();
  await rejected;
  assert.equal(engine.ready, false);
  assert.equal(worker.terminated, true);
});

test('cancelling while Wasm initialization is pending cannot start a worker later', async t => {
  const { engine, workers, cache, url } = harness(t);
  const replacement = await cache.get(url);
  let release;
  const moduleReady = new Promise(resolve => { release = resolve; });
  cache.set(url, moduleReady);
  const loading = engine.load();
  const rejected = assert.rejects(loading, /cancel/i);
  await engine.stop();
  await rejected;
  cache.set(url, Promise.resolve(replacement));
  const retry = engine.load();
  const worker = await waitForWorker(workers);
  worker.emit({ type: 'ready' });
  await retry;
  release({ WasmWhisperStream: class {}, WasmCorrections: class {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(workers.length, 1);
  assert.equal(engine._mod, replacement);
  assert.equal(engine.ready, true);
  await engine.stop();
});

test('the app loads the transcription model before requesting the microphone', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const start = html.indexOf('  async startMoonshine() {');
  const end = html.indexOf('  async startSenseVoice() {', start);
  assert.ok(start !== -1 && end !== -1);
  let release;
  let microphoneRequests = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const context = vm.createContext({
    navigator: { mediaDevices: { getUserMedia: async () => { microphoneRequests++; return {}; } } },
    loadEngineModule: async () => ({ WhisperEngine: class {
      async load() { await gate; }
      setCorrections() {}
    } }),
    app: { getSettings: () => ({ model: 'synthetic/model' }) },
  });
  const source = html.slice(start, end)
    .replace("import('./whisper-engine.js')", 'loadEngineModule()');
  const Manager = vm.runInContext(`(class { ${source} })`, context);
  const manager = new Manager();
  manager.onStatus = () => {};
  manager._startAudioCapture = async () => {};
  const starting = manager.startMoonshine();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(microphoneRequests, 0);
  release();
  await starting;
  assert.equal(microphoneRequests, 1);
});

test('failed capture setup releases the loaded transcription engine', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const start = html.indexOf('  async startMoonshine() {');
  const end = html.indexOf('  async startSenseVoice() {', start);
  assert.ok(start !== -1 && end !== -1);
  let engineStops = 0;
  let captureStops = 0;
  const context = vm.createContext({
    navigator: { mediaDevices: { getUserMedia: async () => ({}) } },
    loadEngineModule: async () => ({ WhisperEngine: class {
      async load() {}
      setCorrections() {}
      async stop() { engineStops++; }
    } }),
    app: { getSettings: () => ({ model: 'synthetic/model' }) },
  });
  const source = html.slice(start, end)
    .replace("import('./whisper-engine.js')", 'loadEngineModule()');
  const Manager = vm.runInContext(`(class { ${source} })`, context);
  const manager = new Manager();
  manager.onStatus = () => {};
  manager._startAudioCapture = async () => { throw new Error('synthetic capture failure'); };
  manager.stop = options => { assert.equal(options.finalize, false); captureStops++; };
  await assert.rejects(manager.startMoonshine(), /synthetic capture failure/);
  assert.equal(engineStops, 1);
  assert.equal(captureStops, 1);
  assert.equal(manager.whisper, null);
});
