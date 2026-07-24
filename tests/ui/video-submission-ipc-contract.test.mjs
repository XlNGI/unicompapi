import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sharedSource = await readFile('src/shared/video-submission-ipc.ts', 'utf8');
const preloadSource = await readFile('electron/preload.ts', 'utf8');
const handlerSource = await readFile('electron/ipc/storage-ipc.ts', 'utf8');
const taskSource = await readFile('src/domain/entities/task.ts', 'utf8');

test('keeps video preflight, task, execution, invocation and result operations separate', () => {
  for (const operation of [
    'preflight',
    'createTask',
    'createExecution',
    'invokeExecution',
    'receiveResult'
  ]) {
    assert.match(sharedSource, new RegExp(`\\b${operation}\\b`));
    assert.match(preloadSource, new RegExp(`videoSubmissionIpcChannels\\.${operation}`));
    assert.match(handlerSource, new RegExp(`videoSubmissionIpcChannels\\.${operation}`));
  }
  assert.doesNotMatch(sharedSource, /upload|poll|progress|cancel/);
  assert.match(sharedSource, /result_verification_failed/);
  assert.match(sharedSource, /works: readonly/);
});

test('keeps video submission DTOs free of protected main-process facts', () => {
  for (const protectedField of [
    'absolutePath',
    'relativePath',
    'checksumSha256',
    'credentialReference',
    'endpoint',
    'remoteOperationId',
    'internalCommand',
    'errorStack'
  ]) {
    assert.doesNotMatch(sharedSource, new RegExp(protectedField));
  }
  assert.match(taskSource, /materials: readonly VideoSubmissionMaterialSnapshot\[\]/);
  assert.match(taskSource, /contextReferences: readonly VideoContextReference\[\]/);
  assert.match(taskSource, /costPrivacyRegion: true/);
});

test('does not introduce fixed models, parameters, prices or fake execution facts', () => {
  assert.doesNotMatch(
    sharedSource,
    /OpenAI|Runway|Kling|Sora|16:9|1080p|24fps|50%|¥\d|\$\d/
  );
  assert.match(sharedSource, /parameterSchema/);
  assert.match(sharedSource, /modeSchema/);
  assert.match(sharedSource, /adapter_unavailable/);
});
