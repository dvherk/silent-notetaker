import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function harness(failWrite) {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const start = html.indexOf('  async handleFinal(text, speakerInfo = null) {');
  const end = html.indexOf('    // Local regex trigger notes', start);
  assert.ok(start !== -1 && end !== -1);
  const notices = [];
  const events = [];
  const context = vm.createContext({
    document: { getElementById: () => ({ style: {} }) },
    storage: {
      addTranscriptChunk: async () => {
        if (failWrite) throw new Error('storage unavailable');
      },
    },
    emitToExtensions: event => events.push(event),
    showToast: text => notices.push(text),
    console: { error() {} },
  });
  const App = vm.runInContext(`(class { ${html.slice(start, end)} } })`, context);
  const app = new App();
  app.meetingId = 42;
  app.tm = { engine: 'moonshine' };
  app.renderTranscriptItem = (...args) => { app.rendered = args; };
  return { app, notices, events };
}

test('a transcript write failure remains visible without claiming it was committed', async () => {
  const { app, notices, events } = await harness(true);
  await app.handleFinal('  discussion text  ');

  assert.equal(app.rendered[1], 'discussion text');
  assert.equal(events.length, 0);
  assert.match(notices[0], /not saved/i);
});

test('a successful transcript write still emits and renders the committed segment', async () => {
  const { app, notices, events } = await harness(false);
  await app.handleFinal('discussion text');

  assert.equal(app.rendered[1], 'discussion text');
  assert.equal(events[0].type, 'transcript.update');
  assert.equal(notices.length, 0);
});
