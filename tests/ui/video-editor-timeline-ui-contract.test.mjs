import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const editorSource = await readFile(
  'src/pages/creation/video/VideoEditingPage.tsx',
  'utf8'
);
const stylesSource = await readFile('src/styles/pages.css', 'utf8');

test('A2 consumes every controlled B2 source and preview operation', () => {
  for (const operation of [
    'selectSource',
    'attachWork',
    'getSourceStatus',
    'prepareRelink',
    'confirmRelink',
    'createSourcePreview',
    'createBackgroundMusicPreview',
    'clearPreviewCache'
  ]) {
    assert.match(editorSource, new RegExp(`videoEditors\\.${operation}\\(`));
  }
  assert.doesNotMatch(editorSource, /showOpenDialog|readFileSync|file:\/\/|fetch\(/);
});

test('A2 sends domain commands for timeline and canvas edits', () => {
  for (const kind of [
    'trim_clip',
    'split_clip',
    'remove_clip',
    'restore_clip',
    'duplicate_clip',
    'move_clip',
    'set_clip_speed',
    'set_clip_transform',
    'set_canvas'
  ]) {
    assert.match(editorSource, new RegExp(`kind: '${kind}'`));
  }
  assert.doesNotMatch(editorSource, /setVideoTrack|setRemovedClips|timelineStart/);
});

test('A2 keeps source recovery visible without exposing proxy as a player control', () => {
  for (const text of [
    '重新定位源文件',
    '候选视频与原文件不同',
    '文件丢失',
    '内容已变化',
    '存储已断开',
    '清除预览缓存',
    'adapter_unavailable'
  ]) {
    assert.match(editorSource, new RegExp(text));
  }
  assert.doesNotMatch(editorSource, /检查预览代理|>\s*代理\s*</);
});

test('A2 has responsive selected, preview, playhead and inspector styling', () => {
  for (const className of [
    'uc-video-editor__media-item--selected',
    'uc-video-editor__video',
    'uc-video-editor__playhead',
    'uc-video-editor__inspector-content',
    'uc-video-editor__form'
  ]) {
    assert.match(editorSource, new RegExp(className));
    assert.match(stylesSource, new RegExp(`\\.${className}`));
  }
});
