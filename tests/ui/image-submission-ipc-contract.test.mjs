import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const preloadSource = await readFile('electron/preload.ts', 'utf8');
const handlerSource = await readFile('electron/ipc/storage-ipc.ts', 'utf8');
const sharedSource = await readFile('src/shared/image-submission-ipc.ts', 'utf8');

test('keeps image preflight, task, execution, invocation and result operations separate', () => {
  for (const operation of [
    'preflight',
    'createTask',
    'createExecution',
    'invokeExecution',
    'receiveResult'
  ]) {
    assert.match(preloadSource, new RegExp(`${operation}:`));
    assert.match(handlerSource, new RegExp(`imageSubmissionIpcChannels\\.${operation}`));
  }

  assert.match(sharedSource, /requiresSubmissionConfirmation: true/);
  assert.match(sharedSource, /costState: 'unknown'/);
  assert.match(sharedSource, /parameterSchema/);
  assert.match(sharedSource, /adapter_unavailable/);
  assert.doesNotMatch(
    sharedSource,
    /absolutePath|checksumSha256|credentialReference|endpoint|remoteOperationId|errorStack/
  );
});
