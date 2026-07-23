import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workbenchSource = await readFile(
  'src/pages/creation/video/VideoWorkbenchPage.tsx',
  'utf8'
);
const modesSource = await readFile(
  'src/pages/creation/creationModes.ts',
  'utf8'
);
const videoPages = await Promise.all(
  [
    'VideoQuickPage.tsx',
    'TextToVideoPage.tsx',
    'ImageToVideoPage.tsx',
    'VideoEditingPage.tsx'
  ].map((name) => readFile(`src/pages/creation/video/${name}`, 'utf8'))
);

test('video workbench uses only the real B1 local draft operations', () => {
  assert.match(workbenchSource, /storage\.getProjectSession\(\)/);
  assert.match(workbenchSource, /videoWorkspaces\.list\(\)/);
  assert.match(workbenchSource, /videoWorkspaces\.create\(workspaceMode\)/);
  assert.match(workbenchSource, /videoWorkspaces\.update\(/);
  assert.match(workbenchSource, /providers[\s\S]{0,50}\.getRegistry\(\)/);
  assert.doesNotMatch(
    workbenchSource,
    /fetch\(|upload|submitTask|createTask|createExecution|invokeExecution|receiveResult|localStorage/
  );
});

test('video workbench keeps blocked and unknown states honest', () => {
  for (const text of [
    '需要先打开项目',
    '正在读取视频工作区',
    '本地视频草稿保存失败',
    '旧预检已过期',
    '未发现',
    '未知，等待 B3 预检',
    '等待 B2 受控媒体端口',
    '不可用',
    '不会显示示例视频或伪造进度',
    '能力预检未接入，无法提交'
  ]) {
    assert.match(workbenchSource, new RegExp(text));
  }
  assert.doesNotMatch(
    workbenchSource,
    /OpenAI|Anthropic|Runway|Kling|Sora|16:9|1080p|24fps|50%|¥\d|\$\d/
  );
});

test('all four video pages reuse the shared shell and single mode source', () => {
  for (const pageSource of videoPages) {
    assert.match(pageSource, /VideoWorkbenchPage/);
    assert.match(pageSource, /videoCreationModes/);
    assert.doesNotMatch(pageSource, /CreationModePage/);
  }

  for (const mode of ['quick_video', 'text_to_video', 'image_to_video']) {
    assert.match(modesSource, new RegExp(`workspaceMode: '${mode}'`));
  }
  assert.doesNotMatch(modesSource, /workspaceMode:\s*'video_editing'/);
});

test('saving stays separate from submission and phase 7 editing', () => {
  for (const text of [
    '新建本地草稿',
    '保存本地草稿',
    '没有创建或提交任务',
    '基础编辑将在阶段 7 实现',
    '不会显示可操作的假时间线',
    '阶段 6 不创建编辑草稿'
  ]) {
    assert.match(workbenchSource, new RegExp(text));
  }
});
