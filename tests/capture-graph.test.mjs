import assert from 'node:assert/strict';
import test from 'node:test';

import { CaptureGraph } from '../apps/web/js/capture.js';

function replaceGlobal(t, name, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, name, original);
    else delete globalThis[name];
  });
}

function track(kind) {
  return { kind, stopped: 0, onended: null, stop() { this.stopped++; } };
}

function stream(...tracks) {
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter(item => item.kind === 'audio'),
    getVideoTracks: () => tracks.filter(item => item.kind === 'video'),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('worklet startup failure stops the microphone, closes the context and revokes its URL', async t => {
  const mic = track('audio');
  let context;
  replaceGlobal(t, 'navigator', { mediaDevices: { getUserMedia: async () => stream(mic) } });
  replaceGlobal(t, 'AudioContext', class {
    constructor() {
      context = this;
      this.state = 'running';
      this.audioWorklet = { addModule: async () => { throw new Error('worklet failed'); } };
    }
    createGain() { return { gain: {}, connect() {} }; }
    createMediaStreamSource() { return { connect() {} }; }
    close() { this.closed = true; return Promise.resolve(); }
  });
  const revoked = [];
  t.mock.method(URL, 'createObjectURL', () => 'blob:test');
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));

  const graph = new CaptureGraph();
  await assert.rejects(graph.startAudioCapture(), /worklet failed/);
  assert.equal(mic.stopped, 1);
  assert.equal(context.closed, true);
  assert.deepEqual(revoked, ['blob:test']);
  assert.equal(graph.mediaStream, null);
  assert.equal(graph.audioContext, null);
  assert.equal(graph.isRecording, false);
});

test('stopping during a microphone permission prompt discards the eventual stream', async t => {
  const mic = track('audio');
  const pending = deferred();
  replaceGlobal(t, 'navigator', { mediaDevices: { getUserMedia: () => pending.promise } });
  const graph = new CaptureGraph();

  const starting = graph.startAudioCapture();
  graph.stop();
  pending.resolve(stream(mic));

  await assert.rejects(starting, /stopped/i);
  assert.equal(mic.stopped, 1);
  assert.equal(graph.mediaStream, null);
  assert.equal(graph.isRecording, false);
});

test('capture ignores stale worklet messages across stop and restart', async t => {
  const tracks = [];
  const received = [];
  replaceGlobal(t, 'navigator', {
    mediaDevices: {
      getUserMedia: async () => {
        const mic = track('audio');
        tracks.push(mic);
        return stream(mic);
      },
    },
  });
  replaceGlobal(t, 'AudioContext', class {
    constructor() {
      this.state = 'running';
      this.destination = {};
      this.audioWorklet = { addModule: async () => {} };
    }
    createGain() { return { gain: {}, connect() {} }; }
    createMediaStreamSource() { return { connect() {} }; }
    close() { return Promise.resolve(); }
  });
  replaceGlobal(t, 'AudioWorkletNode', class {
    constructor() { this.port = {}; }
    connect() {}
    disconnect() {}
  });
  t.mock.method(URL, 'createObjectURL', () => 'blob:test');
  t.mock.method(URL, 'revokeObjectURL', () => {});

  const graph = new CaptureGraph({ onSamples: samples => received.push([...samples]) });
  await graph.startAudioCapture();
  const firstProcessor = graph.processor;
  firstProcessor.port.onmessage({ data: [0.25, -0.5] });
  graph.stop();
  firstProcessor.port.onmessage({ data: [0.75] });
  await graph.startAudioCapture();
  firstProcessor.port.onmessage({ data: [0.9] });
  graph.processor.port.onmessage({ data: [0.5] });
  graph.stop();

  assert.deepEqual(received, [[0.25, -0.5], [0.5]]);
  assert.deepEqual(tracks.map(item => item.stopped), [1, 1]);
});

test('stopping during worklet loading prevents capture from restarting', async t => {
  const mic = track('audio');
  const pending = deferred();
  const started = deferred();
  replaceGlobal(t, 'navigator', { mediaDevices: { getUserMedia: async () => stream(mic) } });
  replaceGlobal(t, 'AudioContext', class {
    constructor() {
      this.state = 'running';
      this.audioWorklet = { addModule: () => { started.resolve(); return pending.promise; } };
    }
    createGain() { return { gain: {}, connect() {} }; }
    createMediaStreamSource() { return { connect() {} }; }
    close() { return Promise.resolve(); }
  });
  t.mock.method(URL, 'createObjectURL', () => 'blob:test');
  const revoked = [];
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));

  const graph = new CaptureGraph();
  const starting = graph.startAudioCapture();
  await started.promise;
  graph.stop();
  pending.resolve();

  await assert.rejects(starting, /stopped/i);
  assert.equal(mic.stopped, 1);
  assert.deepEqual(revoked, ['blob:test']);
  assert.equal(graph.isRecording, false);
});

test('a shared screen without audio is stopped without starting screenshots', async t => {
  const video = track('video');
  replaceGlobal(t, 'navigator', { mediaDevices: { getDisplayMedia: async () => stream(video) } });
  const graph = new CaptureGraph();
  graph.audioContext = {};
  graph.processor = {};
  graph.isRecording = true;
  let screenshotsStarted = false;
  graph.startScreenshotCapture = () => { screenshotsStarted = true; };

  await assert.rejects(graph.addSystemAudio(), /No audio track/);
  assert.equal(video.stopped, 1);
  assert.equal(screenshotsStarted, false);
  assert.equal(graph.systemStream, null);
});

test('stopping during a screen sharing prompt discards the eventual stream', async t => {
  const audio = track('audio');
  const video = track('video');
  const pending = deferred();
  replaceGlobal(t, 'navigator', { mediaDevices: { getDisplayMedia: () => pending.promise } });
  const graph = new CaptureGraph();
  graph.audioContext = { close: async () => {} };
  graph.processor = { disconnect() {} };
  graph.isRecording = true;

  const sharing = graph.addSystemAudio();
  graph.stop();
  pending.resolve(stream(audio, video));

  await assert.rejects(sharing, /stopped/i);
  assert.equal(audio.stopped, 1);
  assert.equal(video.stopped, 1);
  assert.equal(graph.systemStream, null);
});

test('tab-audio setup failure releases every acquired track', async t => {
  const audio = track('audio');
  const video = track('video');
  replaceGlobal(t, 'navigator', { mediaDevices: { getDisplayMedia: async () => stream(audio, video) } });
  replaceGlobal(t, 'MediaStream', class { constructor(tracks) { this.tracks = tracks; } });
  const graph = new CaptureGraph();
  graph.audioContext = { createMediaStreamSource() { throw new Error('audio source failed'); } };
  graph.processor = {};
  graph.isRecording = true;
  graph.startScreenshotCapture = () => { throw new Error('screenshots must not start yet'); };

  await assert.rejects(graph.addSystemAudio(), /audio source failed/);
  assert.equal(audio.stopped, 1);
  assert.equal(video.stopped, 1);
  assert.equal(graph.systemStream, null);
});

test('an in-flight screenshot is discarded after screen sharing stops', () => {
  const graph = new CaptureGraph();
  let finishBlob;
  let emitted = 0;
  graph._onScreenshot = () => { emitted++; };
  graph.videoTrack = track('video');
  graph.videoElement = { readyState: 2, videoWidth: 1, videoHeight: 1 };
  graph.captureCanvas = { toBlob(callback) { finishBlob = callback; } };
  graph.captureCtx = { drawImage() {}, getImageData: () => ({ data: [1, 2, 3, 4] }) };

  graph.captureFrame();
  graph.stopScreenshotCapture();
  finishBlob({});

  assert.equal(emitted, 0);
});

test('disabling screenshots prevents capture and discards an in-flight frame', () => {
  let enabled = false;
  const graph = new CaptureGraph({ shouldCaptureScreenshot: () => enabled });
  let finishBlob;
  let draws = 0;
  graph.videoTrack = track('video');
  graph.videoElement = { readyState: 2, videoWidth: 1, videoHeight: 1 };
  graph.captureCanvas = { toBlob(callback) { finishBlob = callback; } };
  graph.captureCtx = {
    drawImage() { draws++; },
    getImageData: () => ({ data: [1, 2, 3, 4] }),
  };
  graph.captureFrame();
  assert.equal(draws, 0);

  enabled = true;
  graph.captureFrame();
  assert.equal(draws, 1);
  enabled = false;
  finishBlob({});
});
