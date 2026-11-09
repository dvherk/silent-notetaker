import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { DiarizationEngine } from '../diarization-engine.js';
import { NotesEngine } from '../notes-engine.js';
import { SessionEngine } from '../session-engine.js';
import { loadSilentWebModule } from '../silent-web-loader.js';

function installCache(t) {
  const previous = globalThis.__silentWebModulePromises;
  const cache = new Map();
  globalThis.__silentWebModulePromises = cache;
  t.after(() => {
    if (previous === undefined) delete globalThis.__silentWebModulePromises;
    else globalThis.__silentWebModulePromises = previous;
  });
  return cache;
}

test('concurrent core loaders initialize a Wasm module once', async t => {
  const cache = installCache(t);
  let release;
  globalThis.__testWasmInitCount = 0;
  globalThis.__testWasmInitGate = new Promise(resolve => { release = resolve; });
  t.after(() => {
    delete globalThis.__testWasmInitCount;
    delete globalThis.__testWasmInitGate;
  });
  const url = 'data:text/javascript,' + encodeURIComponent(
    'export default async function() { globalThis.__testWasmInitCount++; await globalThis.__testWasmInitGate; }'
  );
  const first = loadSilentWebModule(url);
  const second = loadSilentWebModule(url);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(globalThis.__testWasmInitCount, 1);
  assert.equal(cache.size, 1);
  release();
  assert.equal(await first, await second);
});

test('an older failed load cannot evict a newer cached promise', async t => {
  const cache = installCache(t);
  const url = 'test:replaced-load';
  let reject;
  const old = new Promise((resolve, rejectPromise) => { reject = rejectPromise; });
  cache.set(url, old);
  const pending = loadSilentWebModule(url);
  const replacement = Promise.resolve({ newer: true });
  cache.set(url, replacement);
  reject(new Error('older load failed'));
  await assert.rejects(pending, /older load failed/);
  assert.equal(cache.get(url), replacement);
});

for (const [name, Engine, fakeModule] of [
  ['session', SessionEngine, { WasmSession: class {} }],
  ['notes', NotesEngine, {
    WasmNoteEngine: class {},
    WasmQuestionScheduler: class {},
    WasmCorrections: class {},
  }],
]) {
  test(`${name} can retry after shared Wasm initialization fails`, async t => {
    const cache = installCache(t);
    const url = `test:${name}-retry`;
    const failure = new Error('temporary Wasm initialization failure');
    cache.set(url, Promise.reject(failure));
    const engine = new Engine({ pkgUrl: url });

    await assert.rejects(engine.load(), failure);
    assert.equal(cache.has(url), false);
    assert.equal(engine.ready, false);

    cache.set(url, Promise.resolve(fakeModule));
    await engine.load();
    assert.equal(engine.ready, true);
  });
}

test('notes initialization frees partial objects before a retry', async t => {
  const cache = installCache(t);
  const url = 'test:notes-partial';
  let released = 0;
  let attempts = 0;
  cache.set(url, Promise.resolve({
    WasmNoteEngine: class { free() { released++; } },
    WasmQuestionScheduler: class {
      constructor() {
        attempts++;
        if (attempts === 1) throw new Error('scheduler setup failed');
      }
    },
    WasmCorrections: class {},
  }));
  const engine = new NotesEngine({ pkgUrl: url });
  await assert.rejects(engine.load(), /scheduler setup failed/);
  assert.equal(released, 1);
  assert.equal(engine.ready, false);
  await engine.load();
  assert.equal(engine.ready, true);
  assert.equal(attempts, 2);
});

test('speaker model loading can retry after a transient fetch failure', async t => {
  const cache = installCache(t);
  const url = 'test:diarization-retry';
  cache.set(url, Promise.resolve({
    WasmDiarization: { create: async () => ({}) },
  }));
  const previousFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    return fetches === 1
      ? { ok: false, status: 503, statusText: 'Unavailable' }
      : { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
  };
  t.after(() => { globalThis.fetch = previousFetch; });
  const engine = new DiarizationEngine({ pkgUrl: url, melFb: [[1]] });

  await assert.rejects(engine.load(), /503/);
  assert.equal(engine.ready, false);
  await engine.load();
  assert.equal(engine.ready, true);
  assert.equal(fetches, 2);
});

test('speaker initialization cleans up if its ready callback fails', async t => {
  const cache = installCache(t);
  const url = 'test:diarization-callback';
  let released = 0;
  cache.set(url, Promise.resolve({
    WasmDiarization: { create: async () => ({ free() { released++; } }) },
  }));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer,
  });
  t.after(() => { globalThis.fetch = previousFetch; });
  const engine = new DiarizationEngine({ pkgUrl: url, melFb: [[1]] });
  let fail = true;
  engine.onStatus = message => {
    if (message === 'Speaker model ready' && fail) {
      fail = false;
      throw new Error('status callback failed');
    }
  };
  await assert.rejects(engine.load(), /status callback failed/);
  assert.equal(engine.ready, false);
  assert.equal(released, 1);
  await engine.load();
  assert.equal(engine.ready, true);
});

test('app session retry is shared between concurrent callers', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const start = html.indexOf('  _ensureSessionReady() {', html.indexOf('class App {'));
  const end = html.indexOf('  // A null-safe synchronous stub', start);
  assert.ok(start !== -1 && end !== -1);
  const App = vm.runInNewContext(`(class { ${html.slice(start, end)} })`);
  const app = new App();
  app.session = { ready: false };
  let calls = 0;
  let release;
  app._initSession = () => {
    calls++;
    return new Promise(resolve => { release = resolve; });
  };
  const first = app._ensureSessionReady();
  const second = app._ensureSessionReady();
  assert.equal(first, second);
  assert.equal(calls, 1);
  app.session.ready = true;
  release();
  await first;
  await app._ensureSessionReady();
  assert.equal(calls, 1);
});

test('speaker load failure does not retry each segment but a new meeting can retry', async () => {
  const html = (await readFile(new URL('../index.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const start = html.indexOf('class SpeakerTracker {');
  const end = html.indexOf('\n}\n', start) + 2;
  assert.ok(start !== -1 && end > start);
  let attempts = 0;
  const engine = {
    ready: false,
    reset() {},
    async load() {
      attempts++;
      if (attempts === 1) throw new Error('model unavailable');
      this.ready = true;
    },
    async identify() { return { id: 'S1' }; },
  };
  const context = vm.createContext({
    sharedDiarzEngine: engine,
    _ensureDiarzLoaded: async () => engine,
    console: { warn() {} },
  });
  const Tracker = vm.runInContext(`(${html.slice(start, end)})`, context);
  const first = new Tracker();
  assert.equal(await first.identify(new Float32Array(1)), null);
  assert.equal(await first.identify(new Float32Array(1)), null);
  assert.equal(attempts, 1);
  const second = new Tracker();
  assert.equal((await second.identify(new Float32Array(1))).id, 'S1');
  assert.equal(attempts, 2);
});
