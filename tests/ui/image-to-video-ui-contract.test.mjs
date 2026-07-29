import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const imageVideoSource = await readFile(
  'src/pages/creation/video/VideoImageWorkspace.tsx',
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
const bundle = `${imageVideoSource}\n${controlsSource}\n${shellSource}`;

test('image to video uses only capability-driven material slots', () => {
  assert.match(imageVideoSource, /mode === 'image_to_video'/);
  assert.match(imageVideoSource, /schema\.materialSlots\.map/);
  assert.match(imageVideoSource, /acceptedMediaKinds/);
  assert.doesNotMatch(imageVideoSource, /首帧|尾帧|主体参考/);
});

test('image to video keeps local media controlled and does not auto-analyze', () => {
  for (const operation of [
    'selectMaterial',
    'getMaterial',
    'clearMaterial',
    'createMaterialPreview'
  ]) {
    assert.match(imageVideoSource, new RegExp(`\\.${operation}\\(`));
  }
  for (const text of [
    '识别图片（缺少独立端口）',
    '不会自动识图、增强提示词或生成视频',
    '没有上传、识图、增强或创建任务'
  ]) {
    assert.match(imageVideoSource, new RegExp(text));
  }
  assert.doesNotMatch(
    bundle,
    /absolutePath|remoteOperationId|upload\(|analy[sz]e\(|fetch\(/
  );
});

test('image to video keeps requirements and motion fields separate', () => {
  for (const field of [
    'mustKeep',
    'allowedChanges',
    'prohibited',
    'subjectAction',
    'cameraMovement',
    'pace',
    'depthOfField'
  ]) {
    assert.match(imageVideoSource, new RegExp(field));
  }
  for (const label of [
    '必须保持',
    '允许变化',
    '必须避免',
    '主体动作',
    '运镜',
    '节奏',
    '景深'
  ]) {
    assert.match(imageVideoSource, new RegExp(label));
  }
});

test('image to video preserves prompt, stale and submission boundaries', () => {
  for (const text of [
    '用户原始输入',
    '系统补充内容',
    '最终提交提示词',
    '旧内容已过期',
    '增强提示词（缺少真实端口）',
    '检查提交条件',
    '逐项确认本次视频提交',
    '创建视频任务',
    '创建执行记录',
    '提交视频生成',
    '进入基础编辑（等待正式 Work 与阶段 7）',
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
    assert.match(imageVideoSource, new RegExp(`\\.${operation}\\(`));
  }
  for (const operation of [
    'refreshExecution',
    'cancelExecution',
    'recoverExecutions',
    'receiveResult'
  ]) {
    assert.match(imageVideoSource, new RegExp(`videoSubmissions\\.${operation}\\(`));
  }
  assert.match(imageVideoSource, /远端完成状态本身不代表本地作品已完成/);
});

test('video shell renders the image to video workspace', () => {
  assert.match(shellSource, /currentDraft\?\.mode === 'image_to_video'/);
  assert.match(shellSource, /<VideoImageWorkspace/);
});
