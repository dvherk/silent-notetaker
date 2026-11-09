import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { EXECUTOR_WORKER_SRC } from '../apps/web/js/transformers-host.js';

test('model worker decodes chunks in submission order', async () => {
  const start = EXECUTOR_WORKER_SRC.indexOf('const _tf = import(');
  const end = EXECUTOR_WORKER_SRC.indexOf('\n\nlet transcriber', start);
  assert.ok(start !== -1 && end !== -1);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const messages = [];
  const context = vm.createContext({
    self: { postMessage: message => messages.push(message) },
    fakeTf: {
      pipeline: async () => async audio => {
        calls.push(audio[0]);
        if (audio[0] === 1) await gate;
        return { text: `Synthetic ${audio[0]}` };
      },
    },
  });
  vm.runInContext(
    EXECUTOR_WORKER_SRC.slice(0, start) +
      'const _tf = Promise.resolve(fakeTf);' + EXECUTOR_WORKER_SRC.slice(end),
    context,
  );
  await context.self.onmessage({ data: { type: 'init' } });
  await context.self.onmessage({ data: { type: 'transcribe', chunk: 0, audio: [1] } });
  await context.self.onmessage({ data: { type: 'transcribe', chunk: 1, audio: [2] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [1]);
  release();
  for (let attempt = 0; attempt < 20 && messages.filter(message => message.type === 'decoded').length < 2; attempt++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(messages.filter(message => message.type === 'decoded').map(message => message.chunk), [0, 1]);
});

test('model worker reports a failed chunk and continues the queue', async () => {
  const start = EXECUTOR_WORKER_SRC.indexOf('const _tf = import(');
  const end = EXECUTOR_WORKER_SRC.indexOf('\n\nlet transcriber', start);
  assert.ok(start !== -1 && end !== -1);
  const messages = [];
  const context = vm.createContext({
    self: { postMessage: message => messages.push(message) },
    fakeTf: {
      pipeline: async () => async audio => {
        if (audio[0] === 1) throw new Error('synthetic decode failure');
        return { text: 'Synthetic recovery' };
      },
    },
  });
  vm.runInContext(
    EXECUTOR_WORKER_SRC.slice(0, start) +
      'const _tf = Promise.resolve(fakeTf);' + EXECUTOR_WORKER_SRC.slice(end),
    context,
  );
  await context.self.onmessage({ data: { type: 'init' } });
  await context.self.onmessage({ data: { type: 'transcribe', chunk: 0, audio: [1] } });
  await context.self.onmessage({ data: { type: 'transcribe', chunk: 1, audio: [2] } });
  for (let attempt = 0; attempt < 20 && !messages.some(message => message.type === 'decoded'); attempt++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  const error = messages.find(message => message.type === 'error');
  const decoded = messages.find(message => message.type === 'decoded');
  assert.equal(error?.chunk, 0);
  assert.match(error?.message, /synthetic decode failure/);
  assert.equal(decoded?.chunk, 1);
});
