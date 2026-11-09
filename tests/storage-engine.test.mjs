import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { StorageEngine } from '../storage-engine.js';

test('a failed storage module initialization can be retried without retaining the rejected promise', async t => {
  const url = 'test:storage-retry';
  const previous = globalThis.__silentWebModulePromises;
  const cache = new Map();
  globalThis.__silentWebModulePromises = cache;
  t.after(() => {
    if (previous === undefined) delete globalThis.__silentWebModulePromises;
    else globalThis.__silentWebModulePromises = previous;
  });

  const failure = new Error('module initialization failed');
  cache.set(url, Promise.reject(failure));
  const storage = new StorageEngine({ pkgUrl: url });
  await assert.rejects(storage.load(), failure);
  assert.equal(storage.ready, false);
  assert.equal(cache.has(url), false);

  const fakeModule = { add_meeting: (...args) => Promise.resolve(args) };
  cache.set(url, Promise.resolve(fakeModule));
  await storage.load();
  assert.equal(storage.ready, true);
  assert.deepEqual(await storage.addMeeting('Review', 'Agenda', 123), ['Review', 'Agenda', 123]);
});

test('the application storage facade retries after a transient initialization failure', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const start = html.indexOf('let sharedStorageEngine = null;');
  const end = html.indexOf('// `storage`', start);
  assert.ok(start !== -1 && end !== -1);
  let attempts = 0;
  const context = vm.createContext({
    loadEngineModule: async () => ({
      StorageEngine: class {
        async load() {
          attempts++;
          if (attempts === 1) throw new Error('temporary initialization failure');
        }
      },
    }),
  });
  const source = html.slice(start, end)
    .replace("import('./storage-engine.js')", 'loadEngineModule()');
  vm.runInContext(`${source}\nglobalThis.ensureStorageLoaded = _ensureStorageLoaded;`, context);

  await assert.rejects(context.ensureStorageLoaded(), /temporary initialization failure/);
  const storage = await context.ensureStorageLoaded();
  assert.ok(storage);
  assert.equal(attempts, 2);
});
