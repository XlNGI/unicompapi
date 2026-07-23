import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sharedSource = await readFile(
  new URL('../../src/shared/video-workspace-ipc.ts', import.meta.url),
  'utf8'
);
const preloadSource = await readFile(
  new URL('../../electron/preload.ts', import.meta.url),
  'utf8'
);
const mainSource = await readFile(
  new URL('../../electron/ipc/storage-ipc.ts', import.meta.url),
  'utf8'
);
const domainSource = await readFile(
  new URL('../../src/domain/entities/video-workspace.ts', import.meta.url),
  'utf8'
);

test('exposes only controlled local video workspace operations', () => {
  for (const operation of ['create', 'get', 'update', 'list', 'derive']) {
    assert.match(sharedSource, new RegExp(`\\b${operation}\\b`));
    assert.match(preloadSource, new RegExp(`videoWorkspaceIpcChannels\\.${operation}`));
    assert.match(mainSource, new RegExp(`videoWorkspaceIpcChannels\\.${operation}`));
  }

  assert.doesNotMatch(sharedSource, /selectPath|upload|submitTask|invokeExecution|receiveResult/);
  assert.doesNotMatch(sharedSource, /video_editing|batch_video|batch_creation/);
});

test('keeps video workspace DTOs free of protected main-process facts', () => {
  for (const protectedField of [
    'absolutePath',
    'checksumSha256',
    'credentialReference',
    'endpoint',
    'remoteOperationId',
    'internalCommand'
  ]) {
    assert.doesNotMatch(sharedSource, new RegExp(protectedField));
  }

  assert.match(preloadSource, /videoWorkspaces/);
  assert.match(mainSource, /new VideoWorkspaceController/);
});

test('keeps generation drafts separate from the phase 7 editor', () => {
  assert.match(domainSource, /'quick_video'/);
  assert.match(domainSource, /'text_to_video'/);
  assert.match(domainSource, /'image_to_video'/);
  assert.doesNotMatch(domainSource, /mode:\s*'video_editing'/);
  assert.doesNotMatch(sharedSource, /timeline|exportPlan|mediaEngine/);
  assert.match(domainSource, /VideoEditHandoffIntent/);
});
