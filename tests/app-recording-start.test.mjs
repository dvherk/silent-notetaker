import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function harness({ warm = false, failStorage = false, succeed = false } = {}) {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const start = html.indexOf('  async start() {', html.indexOf('class App {'));
  const end = html.indexOf('  async stop() {', start);
  assert.ok(start !== -1 && end !== -1);

  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: id === 'meetingTitle' ? 'Planning' : '',
      style: {}, classList: { add() {}, remove() {} },
    });
    return elements.get(id);
  };
  const updates = [];
  const events = [];
  const messages = [];
  const context = vm.createContext({
    document: { getElementById: element },
    storage: {
      addMeeting: async () => {
        if (failStorage) throw new Error('disk unavailable');
        return 42;
      },
      updateMeetingEnd: async (...args) => { updates.push(args); },
    },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
    meetingAgendaText: () => '',
    setAgendaLocked() {},
    toggleAgendaEditor() {},
    emitToExtensions: event => events.push(event),
    _persistSpeakerNames() {},
    _ensureNotesLoaded: async () => {},
    SmartQ: { reset() {} },
    OpenQs: { reset() {} },
    LiveOutline: { reset() {} },
    applyTeleprompterVisibility() {},
    notesModelOff: () => true,
    loadSettings: () => ({ model: 'nemotron' }),
    PerfMonitor: { start() {}, stop() {} },
    setInterval: () => 1,
    clearInterval() {},
    console,
    TranscriptionManager: class {
      async startNemotron() {
        if (!succeed) throw new Error('microphone denied');
        this.started = true;
      }
      stop(options) { this.stopped = true; this.stopOptions = options; }
    },
  });
  const App = vm.runInContext(`(class { ${html.slice(start, end)} })`, context);
  const app = new App();
  app.session = {
    ready: true,
    state: warm ? 'stopped' : 'idle',
    title: 'Planning',
    start() {
      this.state = 'recording';
      return { events: [], effects: [{ tag: warm ? 'resume_capture_no_reload' : 'load_engine_and_capture' }] };
    },
    stop() { this.state = 'stopped'; return { events: [], effects: [] }; },
    newMeeting() { this.state = 'idle'; return { events: [], effects: [] }; },
    setTitle() { return { events: [], effects: [] }; },
  };
  app._sessionReady = Promise.resolve();
  app._startEpoch = warm ? 123 : null;
  app.meetingId = warm ? 7 : null;
  app.handleStatus = message => messages.push(message);
  app._applySession = () => {};
  app.bridge = { sendScreenshot() {} };
  if (warm) {
    app.tm = {
      engine: 'nemotron',
      nemotron: { reset() {} },
      async _startNemotronCapture() { throw new Error('resume failed'); },
      stop(options) { this.stopped = true; this.stopOptions = options; },
    };
  } else {
    app.tm = null;
  }
  return { app, updates, events, messages, element };
}

test('failed cold capture releases resources and restores an idle session', async () => {
  const { app, updates, events, messages } = await harness();
  await app.start();

  assert.equal(app.session.state, 'idle');
  assert.equal(app.tm.stopped, true);
  assert.equal(app.tm.stopOptions.finalize, false);
  assert.equal(app.meetingId, null);
  assert.equal(updates.length, 1);
  assert.equal(updates[0][0], 42);
  assert.equal(updates[0][2], 0);
  assert.equal(events.at(-1).type, 'meeting.stop');
  assert.match(messages.at(-1), /microphone denied/);
});

test('failed warm resume restores stopped state and the previous meeting', async () => {
  const { app, updates, messages } = await harness({ warm: true });
  await app.start();

  assert.equal(app.session.state, 'stopped');
  assert.equal(app.tm.stopped, true);
  assert.equal(app.tm.stopOptions.finalize, false);
  assert.equal(app.meetingId, 7);
  assert.equal(app._startEpoch, 123);
  assert.equal(updates[0][0], 42);
  assert.match(messages.at(-1), /resume failed/);
});

test('a failed meeting write does not leave the recording state active', async () => {
  const { app, updates, messages } = await harness({ failStorage: true });
  await app.start();

  assert.equal(app.session.state, 'idle');
  assert.equal(app.meetingId, null);
  assert.equal(updates.length, 0);
  assert.match(messages.at(-1), /disk unavailable/);
});

test('a successful start keeps the existing local capture path and recording UI', async () => {
  const { app, element } = await harness({ succeed: true });
  await app.start();

  assert.equal(app.session.state, 'recording');
  assert.equal(app.tm.started, true);
  assert.equal(app.meetingId, 42);
  assert.equal(element('startBtn').style.display, 'none');
  assert.equal(element('stopBtn').style.display, 'inline-flex');
});

test('a duplicate start does not hide the stop control of an active recording', async () => {
  const { app, element, messages } = await harness();
  app.session.state = 'recording';
  element('stopBtn').style.display = 'inline-flex';
  element('startBtn').style.display = 'none';

  await app.start();

  assert.equal(app.session.state, 'recording');
  assert.equal(element('stopBtn').style.display, 'inline-flex');
  assert.equal(element('startBtn').style.display, 'none');
  assert.match(messages.at(-1), /already starting or active/);
});
