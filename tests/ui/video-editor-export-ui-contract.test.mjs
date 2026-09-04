import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const editorSource = await readFile(
  'src/pages/creation/video/VideoEditingPage.tsx',
  'utf8'
);
const appSource = await readFile('src/ui/App.tsx', 'utf8');
const stylesSource = await readFile('src/styles/pages.css', 'utf8');

test('A4 consumes the controlled B4 export lifecycle without a second task store', () => {
  for (const operation of [
    'preflightExport',
    'startExport',
    'getExport',
    'cancelExport',
    'retryExport'
  ]) {
    assert.match(editorSource, new RegExp(`videoEditors\\.${operation}\\(`));
  }
  assert.match(editorSource, /storage\.listTasks\(\)/);
  assert.match(editorSource, /task\.kind === 'video_editing'/);
  assert.doesNotMatch(editorSource, /localStorage|sessionStorage|fetch\(|child_process|absolutePath/);
});

test('A4 exposes true preflight, task, cancellation and recovery states', () => {
  for (const text of [
    '导出确认',
    '空间状态',
    '仅软件编码（当前真实能力）',
    '正在请求取消',
    '需要处理',
    '执行已中断',
    '需要恢复',
    '创建新尝试',
    '旧尝试没有被覆盖'
  ]) {
    assert.match(editorSource, new RegExp(text));
  }
  assert.match(editorSource, /currentPreflight\.output\.container/);
  assert.match(editorSource, /currentPreflight\.output\.videoCodec/);
  assert.match(editorSource, /currentPreflight\.output\.audioCodec/);
  assert.match(editorSource, /preferencesDirty \? undefined : preflight/);
  assert.match(editorSource, /设置尚未保存；保存后才能执行预检或开始导出/);
  assert.doesNotMatch(editorSource, /1080p|2160p|24fps|30fps|60fps|H\.264/);
});

test('A4 gates success, playback and file actions on a registered Work', () => {
  assert.match(editorSource, /task\?\.state === 'completed' && Boolean\(task\.workId\)/);
  assert.match(editorSource, /exportTask\?\.state !== 'completed'/);
  assert.match(editorSource, /storage\.createWorkMediaHandle\(exportTask\.workId\)/);
  assert.match(editorSource, /storage\.revealWorkFile\(exportTask\.workId\)/);
  assert.match(editorSource, /作品已登记/);
  assert.match(editorSource, /onNavigate\('library'\)/);
  assert.match(editorSource, /onNavigate\('tasks'\)/);
  assert.match(appSource, /onNavigate=\{handleNavigate\}/);
  assert.match(appSource, /preferredDraftId=\{openedVideoDraftId\}/);
});

test('A4 export result uses the controlled fullscreen fallback', () => {
  assert.match(editorSource, /const \[resultPreviewExpanded, setResultPreviewExpanded\]/);
  assert.match(editorSource, /controlsList="nofullscreen"/);
  assert.match(editorSource, /className="uc-video-editor__export-preview-video"/);
  assert.match(editorSource, /uc-video-editor__export-preview--expanded/);
  assert.match(editorSource, /aria-label=\{resultPreviewExpanded \? '退出导出视频全屏预览' : '全屏预览导出视频'\}/);
  assert.match(editorSource, /event\.key === 'Escape'\) setResultPreviewExpanded\(false\)/);
  assert.match(
    stylesSource,
    /\.uc-video-editor__export-preview-video::\-webkit-media-controls-fullscreen-button \{[^}]*display: none !important;/
  );
  assert.match(
    stylesSource,
    /\.uc-video-editor__export-preview--expanded \{[^}]*position: fixed;[^}]*z-index: 1000;[^}]*inset: 0;/
  );
});

test('A4 keeps its dense export controls scoped and responsive', () => {
  for (const className of [
    'uc-video-editor__export-confirmation',
    'uc-video-editor__export-task',
    'uc-video-editor__export-result',
    'uc-video-editor__export-actions'
  ]) {
    assert.match(editorSource, new RegExp(className));
    assert.match(stylesSource, new RegExp(`\\.${className}`));
  }
});
