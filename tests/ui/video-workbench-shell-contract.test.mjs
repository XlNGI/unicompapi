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
    'ImageToVideoPage.tsx'
  ].map((name) => readFile(`src/pages/creation/video/${name}`, 'utf8'))
);

test('video workbench uses only the real B1 local draft operations', () => {
  assert.match(workbenchSource, /storage\.getProjectSession\(\)/);
  assert.match(workbenchSource, /videoWorkspaces\.list\(\)/);
  assert.match(workbenchSource, /videoWorkspaces\.create\(workspaceMode\)/);
  assert.match(workbenchSource, /videoWorkspaces\.update\(/);
  assert.doesNotMatch(workbenchSource, /providers[\s\S]{0,50}\.getRegistry\(\)/);
  assert.doesNotMatch(
    workbenchSource,
    /fetch\(|upload|submitTask|createTask|createExecution|invokeExecution|receiveResult|localStorage/
  );
});

test('video workbench keeps controlled and blocked states honest', () => {
  for (const text of [
    '需要先打开项目',
    '正在读取视频工作区',
    '本地视频草稿保存失败',
    '视频服务候选',
    '按当前功能与已保存草稿事实读取',
    '快速与文生视频无素材；图生视频恰好一张图片',
    '运行授权',
    '不会发出请求，也不会伪造进度或结果',
    '页面会按功能读取匹配的安全候选'
  ]) {
    assert.match(workbenchSource, new RegExp(text));
  }
  assert.doesNotMatch(workbenchSource, /B2|B3|B4|A1 页面|页面尚未接线/);
  assert.doesNotMatch(
    workbenchSource,
    /OpenAI|Anthropic|Runway|Kling|Sora|16:9|1080p|24fps|50%|¥\d|\$\d/
  );
});

test('all three generation pages reuse the shared shell and mode source', () => {
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

test('saving a generation draft stays separate from submission', () => {
  for (const text of [
    '新建本地草稿',
    '保存本地草稿',
    '已自动保存',
    '没有创建或提交任务'
  ]) {
    assert.match(workbenchSource, new RegExp(text));
  }
  assert.match(workbenchSource, /usesFlowAutosave/);
});
