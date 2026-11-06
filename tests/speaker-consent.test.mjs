import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

test('a bridge response cannot silently rename a detected speaker', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const start = html.indexOf('function _handleBridgeMessage(msg) {');
  const end = html.indexOf('const PerfMonitor =', start);
  assert.ok(start !== -1 && end !== -1);
  let renames = 0;
  const context = vm.createContext({
    app: { bridge: { _pendingSpeakerId: 'S1' }, tm: { speakerTracker: {} } },
    renameSpeaker() { renames++; },
    renderSpeakerTags() {},
    showToast() {},
    console,
  });
  vm.runInContext(`${html.slice(start, end)}\nglobalThis.handle = _handleBridgeMessage;`, context);
  context.handle({ type: 'query_response', text: 'Jane Smith' });
  assert.equal(renames, 0);
});
