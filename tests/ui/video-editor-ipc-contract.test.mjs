import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sharedSource = await readFile(
  new URL('../../src/shared/video-editor-ipc.ts', import.meta.url),
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
  new URL('../../src/domain/entities/video-editor.ts', import.meta.url),
  'utf8'
);

test('exposes revisioned local editor draft operations only', () => {
  for (const operation of [
    'create',
    'get',
    'list',
    'update',
    'undo',
    'redo',
    'copy'
  ]) {
    assert.match(sharedSource, new RegExp('\\b' + operation + '\\b'));
    assert.match(
      preloadSource,
      new RegExp('videoEditorIpcChannels\\.' + operation)
    );
    assert.match(
      mainSource,
      new RegExp('videoEditorIpcChannels\\.' + operation)
    );
  }

  assert.match(preloadSource, /videoEditors/);
  assert.match(mainSource, /new VideoEditorController/);
  assert.doesNotMatch(sharedSource, /mediaEngine|exportPlan|invokeExecution|createTask/);
});

test('keeps editor DTOs path-free, hash-free and history-free', () => {
  for (const protectedField of [
    'rootDirectory',
    'absolutePath',
    'relativePath',
    'checksumSha256',
    'modifiedAtMs',
    'undoStack',
    'redoStack',
    'internalCommand',
    'processHandle',
    'engineCommand'
  ]) {
    assert.doesNotMatch(sharedSource, new RegExp(protectedField));
  }

  assert.match(sharedSource, /canUndo/);
  assert.match(sharedSource, /canRedo/);
  assert.match(sharedSource, /expectedRevision/);
});

test('keeps the editor non-destructive and outside generation modes', () => {
  assert.match(domainSource, /video_basic_edit/);
  assert.match(domainSource, /removedClips/);
  assert.match(domainSource, /set_background_music/);
  assert.match(domainSource, /prependToVideo/);
  assert.doesNotMatch(sharedSource, /batch_video|video_generation|upload/);
  assert.doesNotMatch(sharedSource, /overwriteSource|overwriteOriginal/);
});
