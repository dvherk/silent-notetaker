import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

test('storage failures do not prevent capture from stopping or the UI from leaving recording state', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const start = html.indexOf('  async stop() {', html.indexOf('class App {'));
  const end = html.indexOf('    // Stop-time global re-clustering', start);
  assert.ok(start !== -1 && end !== -1);
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { style: {}, classList: { add() {}, remove() {} } });
    return elements.get(id);
  };
  let stopped = false;
  const notices = [];
  const context = vm.createContext({
    PerfMonitor: { stopSoon() {} },
    notesModelOff: () => true,
    _addNoteObj: async () => { throw new Error('note write failed'); },
    storage: { updateMeetingEnd: async () => { throw new Error('meeting write failed'); } },
    emitToExtensions() {},
    document: { getElementById: element },
    clearInterval() {},
    showToast: text => notices.push(text),
    console: { warn() {}, error() {} },
  });
  const App = vm.runInContext(`(class { ${html.slice(start, end)} } })`, context);
  const app = new App();
  app.tm = { stop() { stopped = true; } };
  app.noteEngine = { flush: () => [{ text: 'a note' }] };
  app.renderNote = () => {};
  app.meetingId = 42;
  app._startEpoch = Date.now();
  app._syncSessionConfig = () => {};
  app.session = {
    stop: () => ({ events: [], effects: [{ tag: 'run_stop_hooks', payload: {} }] }),
  };
  app._applySession = () => {};
  app.handleStatus = () => {};

  await app.stop();
  assert.equal(stopped, true);
  assert.equal(element('stopBtn').style.display, 'none');
  assert.equal(element('startBtn').style.display, 'inline-flex');
  assert.equal(notices.length, 2);
});
