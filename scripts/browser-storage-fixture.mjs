function check(condition, message) {
  if (!condition) throw new Error(message);
}

function summaryValue(summary) {
  return {
    ...summary,
    screenshotBlobs: summary.screenshotBlobs.map(bytes => Array.from(bytes)),
  };
}

async function seedLegacyDatabase() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.open('SilentNotetaker', 20);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = event => {
      if (event.oldVersion !== 0) {
        request.transaction.abort();
        return;
      }
      const db = request.result;
      for (const name of ['meetings', 'transcriptChunks', 'notes', 'screenshots']) {
        db.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
      }
      const tx = request.transaction;
      tx.objectStore('meetings').add({
        id: 1, title: 'Synthetic legacy meeting', startTime: 1000, endTime: null, duration: 0,
      });
      tx.objectStore('transcriptChunks').add({
        id: 1, meetingId: 1, timestamp: 1100, text: 'Synthetic transcript.', isFinal: true,
      });
      tx.objectStore('notes').add({
        id: 1, meetingId: 1, category: 'decisions', text: 'Synthetic decision.', timestamp: 1100,
      });
      const images = [
        'data:image/jpeg;base64,AQID',
        new Blob([new Uint8Array([4, 5, 6])], { type: 'image/jpeg' }),
        new Uint8Array([7, 8, 9]),
      ];
      images.forEach((image, index) => tx.objectStore('screenshots').add({
        id: index + 1, meetingId: 1, timestamp: 1200 + index,
        image, width: 1, height: 1, analyzed: false,
      }));
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
  });
}

async function resetSyntheticDatabase() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('SilentNotetaker');
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Synthetic database deletion was blocked'));
    request.onsuccess = () => resolve();
  });
  localStorage.removeItem('silentNotetaker_migrated_v3');
}

export async function runMigration() {
  window.storageSmokeStage = 'seed legacy database';
  localStorage.removeItem('silentNotetaker_migrated_v3');
  await seedLegacyDatabase();
  window.storageSmokeStage = 'load Wasm package';
  const wasm = await import(location.origin + '/crates/silent-web/pkg/silent_web.js');
  await wasm.default();

  window.storageSmokeStage = 'read legacy records';
  const before = summaryValue(await wasm.read_database_summary());
  check(before.meetingCount === 1 && before.chunkCount === 1 && before.noteCount === 1,
    'Legacy meeting, transcript, or note was not read');
  check(before.screenshotCount === 3, 'Legacy screenshot count was not preserved');
  check(JSON.stringify(before.screenshotMeta.map(item => item.encoding)) ===
    JSON.stringify(['base64', 'blob', 'bytes']), 'Legacy screenshot encodings were not read');
  check(JSON.stringify(before.screenshotBlobs) === JSON.stringify([
    Array.from(new TextEncoder().encode('data:image/jpeg;base64,AQID')),
    [4, 5, 6],
    [7, 8, 9],
  ]), 'Legacy screenshot bytes were not read correctly');

  const events = [];
  window.storageSmokeStage = 'run migration';
  await wasm.migrate_database(json => events.push(JSON.parse(json)));
  const backupIndex = events.findIndex(event => event.tag === 'backup_ready');
  const migrationIndex = events.findIndex(event =>
    event.tag === 'status_changed' && event.payload.status === 'migrating');
  check(backupIndex >= 0 && migrationIndex > backupIndex, 'Backup was not emitted before migration');
  const backupUrl = events[backupIndex].payload.object_url;
  window.storageSmokeStage = 'read backup';
  const backup = await (await fetch(backupUrl)).json();
  URL.revokeObjectURL(backupUrl);
  check(backup.meetings.length === 1 && backup.transcript_chunks.length === 1 &&
    backup.notes.length === 1 && backup.screenshots.length === 3,
  'Migration backup omitted synthetic fixture records');
  check(JSON.stringify(backup.screenshots.map(item => item.original_encoding)) ===
    JSON.stringify(['base64', 'blob', 'bytes']) &&
    JSON.stringify(backup.screenshots.map(item => item.image_base64)) ===
    JSON.stringify([btoa('data:image/jpeg;base64,AQID'), 'BAUG', 'BwgJ']),
  'Migration backup changed synthetic screenshot bytes or encodings');

  window.storageSmokeStage = 'verify migrated records';
  const after = summaryValue(await wasm.read_database_summary());
  check(JSON.stringify(before) === JSON.stringify(after), 'Legacy snapshot changed after migration');
  check(localStorage.getItem('silentNotetaker_migrated_v3') === '1', 'Migration marker missing');
  const repeatEvents = [];
  window.storageSmokeStage = 'repeat migration';
  await wasm.migrate_database(json => repeatEvents.push(JSON.parse(json)));
  check(repeatEvents.some(event => event.tag === 'status_changed' &&
    event.payload.status === 'already_migrated'), 'Repeated migration was not a no-op');

  const { StorageEngine } = await import(location.origin + '/storage-engine.js');
  const storage = new StorageEngine({ pkgUrl: location.origin + '/crates/silent-web/pkg/silent_web.js' });
  await storage.load();
  window.storageSmokeStage = 'create new meeting';
  const meetingId = await storage.addMeeting('Synthetic new meeting', 'Synthetic agenda', 2000);
  const sentence = 'After a long debate we have decided to ship on Friday.';
  await storage.addTranscriptChunk(meetingId, 2100, sentence);
  const notes = new wasm.WasmNoteEngine();
  const extracted = JSON.parse(notes.analyze(sentence));
  check(extracted.length === 1 && extracted[0].category === 'decisions',
    'Local trigger-note generation failed for the synthetic transcript');
  await storage.addNote(meetingId, extracted[0].category, extracted[0].text, 2100, extracted[0].triggerPhrase);
  await storage.saveFinalNotes(meetingId, 'Synthetic approved notes');
  await storage.updateMeetingEnd(meetingId, 2200, 200);
  notes.free();
  window.storageSmokeStage = 'migration fixture complete';
  return { legacyScreenshots: before.screenshotCount, migrated: true, meetingId, localNotes: extracted.length };
}

export async function verifyAfterReload() {
  const wasm = await import(location.origin + '/crates/silent-web/pkg/silent_web.js');
  await wasm.default();
  const summary = summaryValue(await wasm.read_database_summary());
  const meeting = summary.meetings.find(item => item.title === 'Synthetic new meeting');
  check(summary.meetingCount === 2 && summary.chunkCount === 2 &&
    summary.noteCount === 2 && summary.screenshotCount === 3,
  'Persisted synthetic records were not present after reload');
  check(meeting?.agenda === 'Synthetic agenda' && meeting.finalNotes === 'Synthetic approved notes' &&
    meeting.endTime === 2200 && meeting.duration === 200,
  'The new meeting did not persist its expected fields');
  check(summary.notes.some(note => note.meetingId === meeting.id && note.category === 'decisions'),
    'The locally generated synthetic note did not persist');
  return { meetingCount: summary.meetingCount, noteCount: summary.noteCount, reloaded: true };
}

export async function runDirectUpgrade() {
  window.storageSmokeStage = 'reset synthetic database';
  await resetSyntheticDatabase();
  await seedLegacyDatabase();

  const wasm = await import(location.origin + '/crates/silent-web/pkg/silent_web.js');
  await wasm.default();
  const before = summaryValue(await wasm.read_database_summary());
  const { StorageEngine } = await import(location.origin + '/storage-engine.js');
  const storage = new StorageEngine({ pkgUrl: location.origin + '/crates/silent-web/pkg/silent_web.js' });
  await storage.load();
  window.storageSmokeStage = 'direct legacy upgrade and write';
  const meetingId = await storage.addMeeting('Synthetic direct upgrade', '', 3000);
  const after = summaryValue(await wasm.read_database_summary());
  check(after.meetingCount === before.meetingCount + 1 &&
    after.chunkCount === before.chunkCount && after.noteCount === before.noteCount &&
    after.screenshotCount === before.screenshotCount,
  'Direct upgrade changed synthetic legacy record counts');
  check(JSON.stringify(after.meetings.find(item => item.id === 1)) === JSON.stringify(before.meetings[0]) &&
    JSON.stringify(after.transcriptChunks) === JSON.stringify(before.transcriptChunks) &&
    JSON.stringify(after.notes) === JSON.stringify(before.notes) &&
    JSON.stringify(after.screenshotMeta) === JSON.stringify(before.screenshotMeta) &&
    JSON.stringify(after.screenshotBlobs) === JSON.stringify(before.screenshotBlobs),
  'Direct upgrade changed synthetic legacy records');
  const version = await new Promise((resolve, reject) => {
    const request = indexedDB.open('SilentNotetaker');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const version = request.result.version;
      request.result.close();
      resolve(version);
    };
  });
  check(version === 40 && !localStorage.getItem('silentNotetaker_migrated_v3'),
    'Direct upgrade did not follow the expected unbacked-up v4 path');
  window.storageSmokeStage = 'direct upgrade fixture complete';
  return { meetingId, version, legacyScreenshots: after.screenshotCount, backupFlowInvoked: false };
}

export async function runFreshDatabase() {
  window.storageSmokeStage = 'reset for fresh database';
  await resetSyntheticDatabase();
  const { StorageEngine } = await import(location.origin + '/storage-engine.js');
  const storage = new StorageEngine({ pkgUrl: location.origin + '/crates/silent-web/pkg/silent_web.js' });
  await storage.load();
  window.storageSmokeStage = 'create fresh database and records';
  const meetingId = await storage.addMeeting('Synthetic fresh meeting', '', 4000);
  let writeError;
  try {
    await storage.saveFinalNotes(99999, 'Synthetic missing meeting');
  } catch (error) {
    writeError = String(error);
  }
  check(writeError?.includes('not found'), 'Missing meeting write did not report an error');
  await storage.addTranscriptChunk(meetingId, 4100, 'Synthetic fresh transcript.');
  await storage.addNote(meetingId, 'decisions', 'Synthetic fresh decision.', 4100, '');
  await storage.addScreenshot(meetingId, 4200, 'data:image/jpeg;base64,AQID', 1, 1);
  await storage.saveSpeakerNames(meetingId, { S1: 'Synthetic speaker' });
  check((await storage.loadSpeakerNames(meetingId)).S1 === 'Synthetic speaker',
    'Fresh speaker-name map did not persist');
  const summary = summaryValue(await storage.readDatabaseSummary());
  check(summary.meetingCount === 1 && summary.chunkCount === 1 &&
    summary.noteCount === 1 && summary.screenshotCount === 1 &&
    summary.meetings[0].id === meetingId,
  'Fresh database did not preserve synthetic records after the rejected write');
  window.storageSmokeStage = 'fresh database fixture complete';
  return { meetingId, rejectedMissingMeetingWrite: true, continuedAfterError: true };
}
