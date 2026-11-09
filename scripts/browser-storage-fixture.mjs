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

export async function runMigration() {
  localStorage.removeItem('silentNotetaker_migrated_v3');
  await seedLegacyDatabase();
  const wasm = await import(location.origin + '/crates/silent-web/pkg/silent_web.js');
  await wasm.default();

  const before = summaryValue(await wasm.read_database_summary());
  check(before.meetingCount === 1 && before.chunkCount === 1 && before.noteCount === 1,
    'Legacy meeting, transcript, or note was not read');
  check(before.screenshotCount === 3, 'Legacy screenshot count was not preserved');
  check(JSON.stringify(before.screenshotMeta.map(item => item.encoding)) ===
    JSON.stringify(['base64', 'blob', 'bytes']), 'Legacy screenshot encodings were not read');

  const events = [];
  await wasm.migrate_database(json => events.push(JSON.parse(json)));
  const backupIndex = events.findIndex(event => event.tag === 'backup_ready');
  const migrationIndex = events.findIndex(event =>
    event.tag === 'status_changed' && event.payload.status === 'migrating');
  check(backupIndex >= 0 && migrationIndex > backupIndex, 'Backup was not emitted before migration');
  const backupUrl = events[backupIndex].payload.object_url;
  const backup = await (await fetch(backupUrl)).json();
  URL.revokeObjectURL(backupUrl);
  check(backup.meetings.length === 1 && backup.transcript_chunks.length === 1 &&
    backup.notes.length === 1 && backup.screenshots.length === 3,
  'Migration backup omitted synthetic fixture records');

  const after = summaryValue(await wasm.read_database_summary());
  check(JSON.stringify(before) === JSON.stringify(after), 'Legacy snapshot changed after migration');
  check(localStorage.getItem('silentNotetaker_migrated_v3') === '1', 'Migration marker missing');
  const repeatEvents = [];
  await wasm.migrate_database(json => repeatEvents.push(JSON.parse(json)));
  check(repeatEvents.some(event => event.tag === 'status_changed' &&
    event.payload.status === 'already_migrated'), 'Repeated migration was not a no-op');

  const meetingId = await wasm.add_meeting('Synthetic new meeting', 'Synthetic agenda', 2000);
  const sentence = 'After a long debate we have decided to ship on Friday.';
  await wasm.add_transcript_chunk(meetingId, 2100, sentence);
  const notes = new wasm.WasmNoteEngine();
  const extracted = JSON.parse(notes.analyze(sentence));
  check(extracted.length === 1 && extracted[0].category === 'decisions',
    'Local trigger-note generation failed for the synthetic transcript');
  await wasm.add_note(meetingId, extracted[0].category, extracted[0].text, 2100, extracted[0].triggerPhrase);
  await wasm.save_final_notes(meetingId, 'Synthetic approved notes');
  await wasm.update_meeting_end(meetingId, 2200, 200);
  notes.free();
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
