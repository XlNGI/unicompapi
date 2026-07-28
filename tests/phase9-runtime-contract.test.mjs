import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('B3 routes production media processes through the managed supervisor', async () => {
  const adapter = await read('src/platform/videos/media-engine-adapter.ts');
  const preview = await read('src/platform/videos/ffmpeg-video-editor-preview.ts');
  const supervisor = await read('src/platform/runtime/managed-process.ts');

  assert.match(adapter, /ManagedProcessSupervisor/);
  assert.doesNotMatch(adapter, /from 'node:child_process'/);
  assert.match(preview, /ManagedProcessSupervisor/);
  assert.doesNotMatch(preview, /from 'node:child_process'/);
  assert.match(supervisor, /shell:\s*false/);
  assert.match(supervisor, /taskkill\.exe/);
  assert.match(supervisor, /process\.kill\(-child\.pid/);
  assert.match(supervisor, /handle\.cancel\('timed_out'\)/);
});

test('B3 maps power and shutdown lifecycle to controlled export interruption', async () => {
  const main = await read('electron/main.ts');
  const storage = await read('electron/ipc/storage-ipc.ts');
  const exports = await read('src/platform/ipc/video-export-controller.ts');

  assert.match(main, /powerMonitor\.on\('suspend'/);
  assert.match(main, /powerMonitor\.on\('lock-screen'/);
  assert.match(main, /event\.preventDefault\(\)/);
  assert.match(main, /storageLifecycle\.dispose\(\)/);
  assert.match(storage, /mediaHandles\.clear\(\)/);
  assert.match(exports, /'recovery_required'/);
  assert.match(exports, /interruptActiveExports/);
});

test('B3 keeps renderer external navigation on the HTTPS-only policy', async () => {
  const main = await read('electron/main.ts');
  const policy = await read('src/platform/runtime/external-url-policy.ts');

  assert.match(main, /normalizeTrustedExternalUrl/);
  assert.doesNotMatch(main, /shell\.openExternal\(url\)/);
  assert.match(policy, /url\.protocol !== 'https:'/);
  assert.match(policy, /url\.username\.length > 0/);
  assert.match(policy, /url\.password\.length > 0/);
});
