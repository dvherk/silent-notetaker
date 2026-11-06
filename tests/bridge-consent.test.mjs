import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { ClaudeBridge } from '../apps/web/js/bridge-client.js';

test('new and legacy settings require a fresh bridge disclosure before enabling cloud processing', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const start = html.indexOf('const DEFAULT_SETTINGS = {');
  const end = html.indexOf('// Expose to App', start);
  assert.ok(start !== -1 && end !== -1);
  let saved = null;
  const context = vm.createContext({
    localStorage: { getItem: () => saved, setItem: (_, value) => { saved = value; } },
  });
  vm.runInContext(`${html.slice(start, end)}\nglobalThis.readSettings = loadSettings;`, context);

  assert.equal(context.readSettings().claudeBridge, false);
  saved = JSON.stringify({ claudeBridge: true, model: 'sensevoice' });
  assert.equal(context.readSettings().claudeBridge, false);
  assert.equal(context.readSettings().model, 'sensevoice');
  saved = JSON.stringify({ claudeBridge: true, claudeBridgeConsentVersion: 1 });
  assert.equal(context.readSettings().claudeBridge, true);
  saved = JSON.stringify({ claudeBridge: false, claudeBridgeConsentVersion: 1 });
  assert.equal(context.readSettings().claudeBridge, false);
});

test('bridge never connects or sends without current explicit consent', t => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete globalThis.document;
    if (originalSocket) Object.defineProperty(globalThis, 'WebSocket', originalSocket);
    else delete globalThis.WebSocket;
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true, writable: true, value: { getElementById: () => null },
  });
  const sockets = [];
  class FakeSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 1; this.messages = []; sockets.push(this); }
    send(value) { this.messages.push(value); }
    close() { this.readyState = 3; }
  }
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: FakeSocket });
  let settings = { claudeBridge: true };
  let received = 0;
  const policy = {
    setEnabled() {},
    connectRequested: () => ({ action: 'connect' }),
    open() {},
    closed: () => ({ action: 'none' }),
    reset() {},
  };
  const bridge = new ClaudeBridge({
    loadSettings: () => settings, reconnectPolicy: policy, onMessage: () => { received++; },
  });

  bridge.connect();
  bridge._openSocket();
  assert.equal(sockets.length, 0);

  settings = { claudeBridge: true, claudeBridgeConsentVersion: 1 };
  bridge.connect();
  assert.equal(sockets.length, 1);
  sockets[0].onopen();
  assert.equal(bridge.sendTranscript('meeting text', 1), true);
  assert.equal(sockets[0].messages.length, 2);

  settings = { claudeBridge: false, claudeBridgeConsentVersion: 1 };
  assert.equal(bridge.sendTranscript('must not leave', 2), false);
  assert.equal(bridge.sendScreenshot('private image', 3), false);
  assert.equal(sockets[0].messages.length, 2);
  sockets[0].onmessage({ data: '{"type":"enhanced_notes"}' });
  assert.equal(received, 0);
});
