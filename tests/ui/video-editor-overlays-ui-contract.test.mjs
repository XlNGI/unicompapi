import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const editorSource = await readFile(
  'src/pages/creation/video/VideoEditingPage.tsx',
  'utf8'
);
const sharedSource = await readFile('src/shared/video-editor-ipc.ts', 'utf8');
const preloadSource = await readFile('electron/preload.ts', 'utf8');
const mainSource = await readFile('electron/ipc/storage-ipc.ts', 'utf8');
const stylesSource = await readFile('src/styles/pages.css', 'utf8');

test('A3 uses reversible editor commands for text, audio and cover edits', () => {
  for (const kind of [
    'set_source_audio',
    'upsert_text',
    'remove_text',
    'update_background_music',
    'clear_background_music',
    'set_cover'
  ]) {
    assert.match(editorSource, new RegExp(`kind: '${kind}'`));
  }
  assert.match(editorSource, /document\.fonts\.check/);
  assert.match(editorSource, /endUs > totalDurationUs/);
  assert.match(editorSource, /fadeInUs \+ fadeOutUs/);
});

test('A3 selects music and covers only through controlled main-process ports', () => {
  for (const operation of [
    'selectBackgroundMusic',
    'selectCoverImage',
    'attachCoverWork'
  ]) {
    assert.match(sharedSource, new RegExp(`\\b${operation}\\b`));
    assert.match(preloadSource, new RegExp(`videoEditorIpcChannels\\.${operation}`));
    assert.match(mainSource, new RegExp(`videoEditorIpcChannels\\.${operation}`));
    assert.match(editorSource, new RegExp(`videoEditors\\.${operation}\\(`));
  }
  assert.doesNotMatch(editorSource, /absolutePath|file:\/\/|showOpenDialog|readFileSync/);
});

test('A3 makes cover insertion explicit and defaults to a non-destructive cover', () => {
  assert.match(editorSource, /仅作为封面（默认）/);
  assert.match(editorSource, /拼接到视频开头/);
  assert.match(editorSource, /setPrependToVideo\(value === 'prepend'\)/);
  assert.match(editorSource, /封面不改变视频内容/);
});

test('A3 keeps dense controls scoped and responsive', () => {
  for (const className of [
    'uc-video-editor__layer-list',
    'uc-video-editor__choice',
    'uc-video-editor__form'
  ]) {
    assert.match(editorSource, new RegExp(className));
    assert.match(stylesSource, new RegExp(`\\.${className}`));
  }
});
