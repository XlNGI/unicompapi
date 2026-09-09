import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const editorSource = await readFile(
  'src/pages/creation/video/VideoEditingPage.tsx',
  'utf8'
);
const modesSource = await readFile(
  'src/pages/creation/creationModes.ts',
  'utf8'
);
const stylesSource = await readFile('src/styles/pages.css', 'utf8');

test('video editor shell consumes only the controlled B1 operations', () => {
  assert.match(editorSource, /storage\.getProjectSession\(\)/);
  for (const operation of [
    'create',
    'get',
    'list',
    'update',
    'undo',
    'redo',
    'copy'
  ]) {
    assert.match(editorSource, new RegExp(`videoEditors\\.?\\!?\\.${operation}\\(`));
  }
  assert.doesNotMatch(
    editorSource,
    /videoWorkspaces|videoSubmissions|videoFeatures|providers|fetch\(|localStorage/
  );
});

test('video editor shell exposes the frozen A1 regions and honest states', () => {
  for (const text of [
    '素材与片段',
    '预览舞台',
    '轻量单轨时间线',
    '视频主轨',
    '文字轨',
    '背景音乐',
    '属性面板',
    '需要先打开项目',
    '读取编辑工作区',
    '保存中',
    '保存失败，修改仍保留',
    '版本冲突',
    '来源作品或视频草稿已不可用',
    '重新载入'
  ]) {
    assert.match(editorSource, new RegExp(text));
  }
  assert.match(modesSource, /本地优先、非破坏式的轻量单轨视频编辑/);
});

test('video editor shell keeps unverified media options out of the UI', () => {
  for (const text of [
    '媒体引擎尚未审批',
    '不上传、不调用在线智能服务、不创建任务',
    '等待媒体引擎真实预检'
  ]) {
    assert.match(editorSource, new RegExp(text));
  }
  assert.doesNotMatch(
    editorSource,
    /MediaEngine|ExportPlan|createTask|invokeExecution|1080p|24fps/
  );
});

test('video editor shell has responsive scoped layout without a second state store', () => {
  for (const className of [
    'uc-video-editor__workspace',
    'uc-video-editor__media-bin',
    'uc-video-editor__preview',
    'uc-video-editor__timeline',
    'uc-video-editor__inspector'
  ]) {
    assert.match(editorSource, new RegExp(className));
    assert.match(stylesSource, new RegExp(`\\.${className}`));
  }
  assert.match(stylesSource, /@media \(max-width: 1500px\)/);
  assert.match(stylesSource, /@media \(max-width: 1180px\)/);
  assert.doesNotMatch(editorSource, /useReducer|createStore|timelineStart/);
});
