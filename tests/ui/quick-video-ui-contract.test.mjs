import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const quickSource = await readFile(
  'src/pages/creation/video/VideoQuickWorkspace.tsx',
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
const appSource = await readFile('src/ui/App.tsx', 'utf8');
const bundle = `${quickSource}\n${controlsSource}\n${shellSource}\n${appSource}`;

test('quick video uses the controlled material and submission APIs', () => {
  for (const operation of [
    'selectMaterial',
    'getMaterial',
    'clearMaterial',
    'createMaterialPreview',
    'preflight',
    'createTask',
    'createExecution',
    'invokeExecution'
  ]) {
    assert.match(quickSource, new RegExp(`\\.${operation}\\(`));
  }

  assert.doesNotMatch(
    bundle,
    /fetch\(|localStorage|absolutePath|remoteOperationId|upload\(|analy[sz]e\(|receiveResult\(/
  );
});

test('quick video keeps every side effect explicit and separate', () => {
  for (const text of [
    '保存本地草稿',
    '检查提交条件',
    '逐项确认本次视频提交',
    '创建视频任务',
    '创建执行记录',
    '提交视频生成',
    '重新生成（等待真实结果）',
    '保存结果（等待真实结果）',
    '进入文生视频'
  ]) {
    assert.match(bundle, new RegExp(text.replace(/[（）]/g, '\\$&')));
  }

  assert.match(quickSource, /\.derive\([\s\S]*'text_to_video'/);
  assert.match(appSource, /'quick-video'[\s\S]*'text-to-video'/);
});

test('quick video has one optional dynamic reference and no fixed result facts', () => {
  assert.match(quickSource, /quickReferenceTarget/);
  assert.match(quickSource, /acceptedMediaKinds/);
  assert.match(quickSource, /单个参考素材（可选）/);
  assert.match(quickSource, /结果数量不设固定默认值/);
  assert.doesNotMatch(
    bundle,
    /默认 1 个结果|1 个视频结果|16:9|1080p|24fps|Runway|Kling|Sora/
  );
});

test('quick video stays honest without an adapter or registered result', () => {
  assert.match(controlsSource, /adapter_unavailable/);
  assert.match(quickSource, /尚无真实视频结果/);
  assert.match(quickSource, /B4 正式登记端口已具备/);
  assert.match(quickSource, /等待真实结果/);
  assert.match(quickSource, /不会伪造进度、费用、结果或成功状态/);
});
