import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const textSource = await readFile(
  'src/pages/creation/video/VideoTextWorkspace.tsx',
  'utf8'
);
const controlsSource = await readFile(
  'src/pages/creation/video/VideoGenerationControls.tsx',
  'utf8'
);
const shellSource = await readFile(
  'src/pages/creation/video/VideoWorkbenchPage.tsx',
  'utf8'
);
const bundle = `${textSource}\n${controlsSource}\n${shellSource}`;

test('text to video keeps the main workflow compact and ordered', () => {
  for (const className of [
    'uc-video-text__main',
    'uc-video-text__work-grid',
    'uc-video-text__materials',
    'uc-video-text__shots',
    'uc-video-text__prompt',
    'uc-video-text__submit'
  ]) {
    assert.match(textSource, new RegExp(className));
  }
});

test('text to video keeps text sources and contexts explicit', () => {
  for (const text of [
    '短创意',
    '长文本 / 故事 / 脚本',
    '项目素材',
    '项目上下文',
    '已保存的对话上下文',
    '已明确选择',
    '不会自动读取'
  ]) {
    assert.match(bundle, new RegExp(text.replace(/\//g, '\\/')));
  }
  assert.doesNotMatch(
    bundle,
    /localStorage|selectContext\(|loadProjectContext\(|loadConversation\(/
  );
});

test('text to video uses dynamic slots and controlled local media only', () => {
  for (const operation of [
    'selectMaterial',
    'getMaterial',
    'clearMaterial',
    'createMaterialPreview'
  ]) {
    assert.match(textSource, new RegExp(`\\.${operation}\\(`));
  }
  assert.match(textSource, /schema\.materialSlots\.map/);
  assert.match(textSource, /acceptedMediaKinds/);
  assert.doesNotMatch(
    bundle,
    /absolutePath|remoteOperationId|upload\(|analy[sz]e\(|fetch\(/
  );
});

test('text to video keeps editable shots and storyboard local', () => {
  for (const text of [
    '镜头方案与分镜状态',
    '添加镜头',
    '主体动作',
    '运镜',
    '节奏',
    '景深',
    '上移',
    '下移',
    '删除镜头',
    '生成镜头草稿（缺少真实端口）',
    '生成分镜草稿（缺少真实端口）'
  ]) {
    assert.match(bundle, new RegExp(text.replace(/[（）]/g, '\\$&')));
  }
  assert.match(textSource, /minimumShots/);
  assert.match(textSource, /maximumShots/);
});

test('text to video preserves three prompt layers and separated submission', () => {
  for (const text of [
    '用户原始输入',
    '系统补充内容',
    '最终提交提示词',
    '检查提交条件',
    '逐项确认本次视频提交',
    '创建视频任务',
    '创建执行记录',
    '提交视频生成',
    'adapter_unavailable'
  ]) {
    assert.match(bundle, new RegExp(text));
  }
  for (const operation of [
    'preflight',
    'createTask',
    'createExecution',
    'invokeExecution'
  ]) {
    assert.match(textSource, new RegExp(`\\.${operation}\\(`));
  }
});
