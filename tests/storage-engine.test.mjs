import assert from 'node:assert/strict';
import test from 'node:test';

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
