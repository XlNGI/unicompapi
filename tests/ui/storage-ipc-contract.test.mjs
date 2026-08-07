import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const preloadSource = await readFile('electron/preload.ts', 'utf8');
const sharedContractSource = await readFile('src/shared/storage-ipc.ts', 'utf8');

test('keeps the storage IPC surface narrow and path-free', () => {
  for (const operation of [
    'probeFile',
    'verifyFile',
    'relinkFile',
    'restoreBackup',
    'rebuildIndex',
    'openProject',
    'createProject',
    'listProjects',
    'getLocalStorageSummary',
    'onLocalStorageChanged',
    'listTasks',
    'getTaskDetails',
    'listCallRecords',
    'getCallDetails',
    'listWorks',
    'getWorkDetails',
    'createWorkMediaHandle',
    'revealWorkFile',
    'closeProject',
    'getProjectSession'
  ]) {
    assert.match(preloadSource, new RegExp(`${operation}:`));
    assert.match(sharedContractSource, new RegExp(`${operation}`));
  }

  assert.doesNotMatch(
    sharedContractSource,
    /rootDirectory|absolutePath|readFile|writeFile|deleteFile/
  );
  assert.doesNotMatch(preloadSource, /rootDirectory|absolutePath/);
  assert.match(preloadSource, /\{ fileId \}/);
});
