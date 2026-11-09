import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const browser = process.env.SILENT_BROWSER_BIN;
if (!browser) {
  console.error('Set SILENT_BROWSER_BIN to a Chrome or Edge executable.');
  process.exitCode = 1;
} else {
  await run(browser);
}

async function waitFor(fn, description, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function run(browserPath) {
  const capture = await readFile(new URL('../apps/web/js/capture.js', import.meta.url));
  const whisperWorkerSmoke = process.env.SILENT_WHISPER_WORKER_SMOKE === '1';
  const appShellSmoke = process.env.SILENT_APP_SHELL_SMOKE === '1' || whisperWorkerSmoke;
  const storageSmoke = process.env.SILENT_STORAGE_WASM_SMOKE === '1' || appShellSmoke;
  const appShell = appShellSmoke ? await readFile(new URL('../index.html', import.meta.url)) : null;
  const extraAssets = new Map();
  if (storageSmoke) {
    extraAssets.set('/storage-fixture.js', {
      content: await readFile(new URL('./browser-storage-fixture.mjs', import.meta.url)),
      type: 'text/javascript',
    });
    extraAssets.set('/storage-engine.js', {
      content: await readFile(new URL('../storage-engine.js', import.meta.url)),
      type: 'text/javascript',
    });
    extraAssets.set('/silent-web-loader.js', {
      content: await readFile(new URL('../silent-web-loader.js', import.meta.url)),
      type: 'text/javascript',
    });
    for (const name of ['session-engine.js', 'notes-engine.js', 'whisper-engine.js']) {
      extraAssets.set(`/${name}`, {
        content: await readFile(new URL(`../${name}`, import.meta.url)),
        type: 'text/javascript',
      });
    }
    extraAssets.set('/apps/web/js/transformers-host.js', {
      content: await readFile(new URL('../apps/web/js/transformers-host.js', import.meta.url)),
      type: 'text/javascript',
    });
    async function addPackageFiles(directory, prefix) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        const url = `${prefix}/${encodeURIComponent(entry.name)}`;
        if (entry.isDirectory()) {
          await addPackageFiles(path, url);
        } else if (entry.isFile()) {
          const type = entry.name.endsWith('.wasm') ? 'application/wasm'
            : /\.(m?js)$/.test(entry.name) ? 'text/javascript' : 'application/octet-stream';
          extraAssets.set(url, { content: await readFile(path), type });
        }
      }
    }
    const packageDirectory = process.env.SILENT_WEB_PKG_DIR ||
      fileURLToPath(new URL('../crates/silent-web/pkg/', import.meta.url));
    await addPackageFiles(packageDirectory,
      '/crates/silent-web/pkg');
    if (appShellSmoke) {
      const root = fileURLToPath(new URL('../', import.meta.url));
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isFile() && /\.(m?js)$/.test(entry.name)) {
          extraAssets.set(`/${encodeURIComponent(entry.name)}`, {
            content: await readFile(join(root, entry.name)), type: 'text/javascript',
          });
        }
      }
      await addPackageFiles(fileURLToPath(new URL('../apps/web/js/', import.meta.url)), '/apps/web/js');
    }
  }
  const profile = await mkdtemp(join(tmpdir(), 'silent-capture-smoke-'));
  const server = createServer((request, response) => {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    response.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; connect-src 'self' blob:");
    if (request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(appShell || '<!doctype html><title>Capture smoke test</title>');
    } else if (request.url === '/capture.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' });
      response.end(capture);
    } else if (extraAssets.has(request.url)) {
      const asset = extraAssets.get(request.url);
      response.writeHead(200, { 'Content-Type': asset.type });
      response.end(asset.content);
    } else {
      console.error(`Browser smoke server: no asset for ${request.url}`);
      response.writeHead(404);
      response.end();
    }
  });

  let connection;
  let browserProcess;
  let debugPort;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const url = `http://127.0.0.1:${server.address().port}/`;
    browserProcess = spawn(browserPath, [
      '--headless=new',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--no-first-run',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      url,
    ], { stdio: 'ignore' });
    let launchError;
    browserProcess.once('error', error => { launchError = error; });

    debugPort = await waitFor(async () => {
      if (launchError) throw launchError;
      try {
        return (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EBUSY') return null;
        throw error;
      }
    }, 'browser debugging port');
    const target = await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
          signal: AbortSignal.timeout(2000),
        });
        const targets = await response.json();
        return targets.find(item => item.type === 'page' && item.url === url);
      } catch (error) {
        if (error.cause?.code === 'ECONNREFUSED' || error.name === 'TimeoutError') return null;
        throw error;
      }
    }, 'capture test page');
    connection = await connect(target.webSocketDebuggerUrl);
    await waitFor(async () => {
      try {
        const page = await evaluate(connection, '({ href: location.href, ready: document.readyState })');
        return page.href === url && page.ready === 'complete';
      } catch (error) {
        if (/execution context/i.test(error.message)) return false;
        throw error;
      }
    }, 'capture test page load');

    if (appShellSmoke) {
      await evaluate(connection, `(async () => {
        await app._sessionReady;
        await Promise.all([
          _ensureStorageLoaded(), _ensureNotesLoaded(),
          _ensureFinalNotesPolicy(), _ensureExportsLoaded(),
          import('./apps/web/js/capture.js'),
          ${whisperWorkerSmoke ? "import('./whisper-engine.js')" : 'Promise.resolve()'},
        ]);
        if (!app.session.ready || !crossOriginIsolated) throw new Error('App shell did not initialize');
        saveSettings({ ...loadSettings(), model: ${JSON.stringify(whisperWorkerSmoke ? 'onnx-community/whisper-tiny.en' : 'nemotron')}, qwenModel: 'off',
          smartQuestions: false, screenshots: false, claudeBridge: false });
        app._syncSessionConfig();
        window.appSmokeSamples = 0;
        ${whisperWorkerSmoke ? `
          window.appSmokeDecoded = 0;
          window.Worker = class {
            postMessage(message) {
              if (message.type === 'init') setTimeout(() => this.onmessage?.({ data: { type: 'ready' } }), 20);
              if (message.type === 'transcribe') setTimeout(() => {
                window.appSmokeDecoded++;
                if (message.chunk > 0) window.appSmokeTailSamples = message.audio.length;
                this.onmessage?.({ data: { type: 'decoded', chunk: message.chunk,
                  text: message.chunk === 0
                    ? 'After a long debate we have decided to ship on Friday.'
                    : 'The synthetic final follow up will be reviewed tomorrow.' } });
              }, 20);
            }
            terminate() {}
          };
        ` : `
          TranscriptionManager.prototype.startNemotron = async function() {
            this.engine = 'nemotron';
            await this._startAudioCapture(samples => {
              if (samples.length) window.appSmokeSamples++;
            });
          };
        `}
      })()`);
    }

    const first = await evaluate(connection, `(async () => {
      const { CaptureGraph } = await import(location.origin + '/capture.js');
      const state = window.captureSmoke = { firstSamples: 0, secondSamples: 0 };
      const graph = state.graph = new CaptureGraph({
        onSamples(samples) { if (samples.length) state.firstSamples++; }
      });
      await graph.startAudioCapture();
      const track = graph.mediaStream.getAudioTracks()[0];
      const sampleRate = graph.audioContext.sampleRate;
      state.oldHandler = graph.processor.port.onmessage;
      await new Promise((resolve, reject) => {
        const timer = setInterval(() => {
          if (state.firstSamples > 0) { clearInterval(timer); clearTimeout(timeout); resolve(); }
        }, 20);
        const timeout = setTimeout(() => { clearInterval(timer); reject(new Error('No fake microphone samples')); }, 12000);
      });
      graph.stop();
      return { sampleRate, samples: state.firstSamples, trackState: track.readyState };
    })()`);
    assert.equal(first.sampleRate, 16_000);
    assert.ok(first.samples > 0);
    assert.equal(first.trackState, 'ended');

    await connection.send('Network.enable');
    await connection.send('Network.emulateNetworkConditions', {
      offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
    });
    const second = await evaluate(connection, `(async () => {
      const state = window.captureSmoke;
      await state.graph.startAudioCapture(samples => { if (samples.length) state.secondSamples++; });
      const before = state.firstSamples;
      state.oldHandler({ data: [0.25] });
      const staleSamplesIgnored = state.firstSamples === before;
      const track = state.graph.mediaStream.getAudioTracks()[0];
      await new Promise((resolve, reject) => {
        const timer = setInterval(() => {
          if (state.secondSamples > 0) { clearInterval(timer); clearTimeout(timeout); resolve(); }
        }, 20);
        const timeout = setTimeout(() => { clearInterval(timer); reject(new Error('No offline fake microphone samples')); }, 12000);
      });
      state.graph.stop();
      return { offline: !navigator.onLine, samples: state.secondSamples, trackState: track.readyState, staleSamplesIgnored };
    })()`);
    assert.equal(second.offline, true);
    assert.ok(second.samples > 0);
    assert.equal(second.trackState, 'ended');
    assert.equal(second.staleSamplesIgnored, true);
    console.log(JSON.stringify({ first, second }, null, 2));
    if (appShellSmoke) {
      const appRun = await evaluate(connection, `(async () => {
        if (navigator.onLine) throw new Error('Offline simulation not active');
        if (loadSettings().claudeBridge || app.bridge.connected) throw new Error('Cloud bridge was enabled');
        document.getElementById('meetingTitle').value = 'Synthetic offline session';
        await app.start();
        if (!app.meetingId || !app.tm?.isRecording) throw new Error('App recording did not start');
        const track = app.tm.mediaStream.getAudioTracks()[0];
        await new Promise((resolve, reject) => {
          const timer = setInterval(() => {
            if (${whisperWorkerSmoke ? 'window.appSmokeDecoded > 0' : 'window.appSmokeSamples > 0'}) {
              clearInterval(timer); clearTimeout(timeout); resolve();
            }
          }, 20);
          const timeout = setTimeout(() => { clearInterval(timer); reject(new Error('No app synthetic audio result')); }, 12000);
        });
        ${whisperWorkerSmoke ? `
          await new Promise((resolve, reject) => {
            const timer = setInterval(async () => {
              try {
                if ((await storage.meetingDetail(app.meetingId)).chunks.length > 0) {
                  clearInterval(timer); clearTimeout(timeout); resolve();
                }
              } catch (error) { clearInterval(timer); clearTimeout(timeout); reject(error); }
            }, 20);
            const timeout = setTimeout(() => { clearInterval(timer); reject(new Error('Synthetic transcript was not persisted')); }, 12000);
          });
        ` : `
          await app.handleFinal('After a long debate we have decided to ship on Friday.');
        `}
        ${whisperWorkerSmoke ? `
          const remainder = app.tm.whisper._mirror.length % 80000;
          const extra = remainder >= 76000 ? 80000 - remainder + 4000 : 4000;
          app.tm.whisper.feed(new Float32Array(extra).fill(0.5));
        ` : ''}
        await app.stop();
        const detail = await storage.meetingDetail(app.meetingId);
        if (track.readyState !== 'ended' || detail.chunks.length !== ${whisperWorkerSmoke ? 2 : 1} ||
          !detail.notes.some(note => note.category === 'decisions')) {
          throw new Error('Offline app capture, transcript or local note did not persist');
        }
        ${whisperWorkerSmoke ? `
          if (!window.appSmokeTailSamples || window.appSmokeTailSamples >= 80000 ||
            !detail.chunks.some(chunk => chunk.text === 'The synthetic final follow up will be reviewed tomorrow.')) {
            throw new Error('Final partial Whisper chunk was not persisted before stop');
          }
        ` : ''}
        return { offline: !navigator.onLine, samples: window.appSmokeSamples,
          syntheticDecodes: window.appSmokeDecoded || 0,
          tailSamples: window.appSmokeTailSamples || 0,
          trackState: track.readyState, chunks: detail.chunks.length, notes: detail.notes.length };
      })()`);
      console.log(JSON.stringify({ appRun }, null, 2));
      console.log('Offline app-shell smoke passed with synthetic capture and a mocked transcript, not a real ASR model.');
    }
    if (storageSmoke) {
      await connection.send('Network.emulateNetworkConditions', {
        offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
      });
    }
    if (appShellSmoke) {
      await connection.send('Page.reload');
      await waitFor(async () => {
        try {
          const page = await evaluate(connection,
            "({ href: location.href, ready: document.readyState, previousState: 'appSmokeSamples' in window })");
          return page.href === url && page.ready === 'complete' && !page.previousState;
        } catch (error) {
          if (/execution context/i.test(error.message)) return false;
          throw error;
        }
      }, 'app shell smoke page reload');
      const appReload = await evaluate(connection, `(async () => {
        const meetings = await storage.recentMeetings();
        const meeting = meetings.find(item => item.title === 'Synthetic offline session');
        if (!meeting) throw new Error('Offline meeting was not persisted after reload');
        const detail = await storage.meetingDetail(meeting.id);
        if (detail.chunks.length !== ${whisperWorkerSmoke ? 2 : 1} || detail.chunks[0].text !==
          'After a long debate we have decided to ship on Friday.' ||
          ${whisperWorkerSmoke ? "detail.chunks[1].text !== 'The synthetic final follow up will be reviewed tomorrow.' ||" : ''}
          !detail.notes.some(note => note.category === 'decisions') ||
          detail.meeting.endTime === null) {
          throw new Error('Offline transcript, local note, or stop time was not persisted after reload');
        }
        return { meetingCount: meetings.length, chunks: detail.chunks.length, notes: detail.notes.length };
      })()`);
      console.log(JSON.stringify({ appReload }, null, 2));
    }
    if (storageSmoke && !appShellSmoke) {
      let engines, migration;
      try {
        engines = await evaluate(connection,
          "import(location.origin + '/storage-fixture.js').then(fixture => fixture.runCoreEngines())");
        migration = await evaluate(connection,
          "import(location.origin + '/storage-fixture.js').then(fixture => fixture.runMigration())");
      } catch (error) {
        const stage = await evaluate(connection, 'window.storageSmokeStage || "before fixture"');
        throw new Error(`Storage smoke failed during ${stage}: ${error.message}`, { cause: error });
      }
      await connection.send('Page.reload');
      await waitFor(async () => {
        try {
          const page = await evaluate(connection,
            "({ href: location.href, ready: document.readyState, previousState: 'captureSmoke' in window })");
          return page.href === url && page.ready === 'complete' && !page.previousState;
        } catch (error) {
          if (/execution context/i.test(error.message)) return false;
          throw error;
        }
      }, 'storage smoke page reload');
      const reload = await evaluate(connection,
        "import(location.origin + '/storage-fixture.js').then(fixture => fixture.verifyAfterReload())");
      let directUpgrade;
      try {
        directUpgrade = await evaluate(connection,
          "import(location.origin + '/storage-fixture.js').then(fixture => fixture.runDirectUpgrade())");
      } catch (error) {
        const stage = await evaluate(connection, 'window.storageSmokeStage || "before direct upgrade"');
        throw new Error(`Storage smoke failed during ${stage}: ${error.message}`, { cause: error });
      }
      let fresh;
      try {
        fresh = await evaluate(connection,
          "import(location.origin + '/storage-fixture.js').then(fixture => fixture.runFreshDatabase())");
      } catch (error) {
        const stage = await evaluate(connection, 'window.storageSmokeStage || "before fresh database"');
        throw new Error(`Storage smoke failed during ${stage}: ${error.message}`, { cause: error });
      }
      console.log(JSON.stringify({ engines, migration, reload, directUpgrade, fresh }, null, 2));
      console.log('Synthetic IndexedDB migration, reload, direct upgrade, and fresh database passed.');
    }
    console.log('Browser capture smoke passed with a synthetic microphone; no ASR or real microphone was tested.');
  } finally {
    if (!connection && debugPort) {
      try {
        const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
        connection = await connect(version.webSocketDebuggerUrl);
      } catch (error) {
        console.warn('Could not reconnect to the test browser for shutdown:', error.message);
      }
    }
    if (connection) {
      await connection.send('Browser.close').catch(error => {
        console.warn('Browser closed before acknowledging shutdown:', error.message);
      });
      connection.close();
    } else if (browserProcess?.pid && browserProcess.exitCode === null) {
      try {
        if (process.platform === 'win32') {
          execFileSync('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            `Stop-Process -Id ${browserProcess.pid} -ErrorAction Stop`,
          ], { stdio: 'ignore' });
        } else {
          browserProcess.kill();
        }
      } catch (error) {
        console.warn(`Could not stop test browser process ${browserProcess.pid}: ${error.message}`);
      }
    }
    if (server.listening) {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    try {
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      console.warn(`Could not remove test browser profile ${profile}: ${error.message}`);
    }
  }
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Browser connection closed'));
    }
    pending.clear();
  });
  return {
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for ${method}`));
        }, 30_000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

async function evaluate(connection, expression) {
  const result = await connection.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
}
