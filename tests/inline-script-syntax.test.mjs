import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

test('all inline application and worker scripts parse', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 3);
  const worker = spawnSync(process.execPath, ['--check', '--input-type=module'], {
    input: scripts[0][1], encoding: 'utf8',
  });
  assert.equal(worker.status, 0, worker.stderr);
  for (const [index, script] of scripts.entries()) {
    if (index === 0) continue;
    new vm.Script(script[1], { filename: `index-inline-${index}.js` });
  }
});
