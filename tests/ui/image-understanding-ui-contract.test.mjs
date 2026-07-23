import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const understandingSource = await readFile(
  'src/pages/creation/image/ImageUnderstandingWorkspace.tsx',
  'utf8'
);
const workbenchSource = await readFile(
  'src/pages/creation/image/ImageWorkbenchPage.tsx',
  'utf8'
);
const appSource = await readFile('src/ui/App.tsx', 'utf8');

test('image understanding keeps five result categories and revisions separate', () => {
  for (const text of [
    '可见事实',
    '模型推断',
    '不确定',
    '无法识别',
    '用户修改',
    '模型原始结果与用户修改记录分别保存',
    '保存为独立修订'
  ]) {
    assert.match(understandingSource, new RegExp(text));
  }

  for (const field of [
    'visibleFacts',
    'modelInferences',
    'uncertainties',
    'unrecognized',
    'userRevisions'
  ]) {
    assert.match(understandingSource, new RegExp(field));
  }
});

test('image understanding uses controlled input, region and honest preflight', () => {
  for (const operation of [
    'selectInput',
    'getInput',
    'createInputPreview',
    'preflight'
  ]) {
    assert.match(understandingSource, new RegExp(`\\.${operation}\\(`));
  }

  for (const text of [
    '识别目的或自定义问题',
    '启用区域识别',
    '结果保存范围',
    '检查识别条件',
    '当前没有真实图片识别适配器',
    '结果已过期'
  ]) {
    assert.match(understandingSource, new RegExp(text));
  }

  assert.match(workbenchSource, /ImageUnderstandingWorkspace/);
  assert.match(workbenchSource, /analysisState === 'stale'[\s\S]*\? 'stale'/);
  assert.doesNotMatch(
    understandingSource,
    /fetch\(|localStorage|absolutePath|upload|\.createTask\(|\.createExecution\(|\.invokeExecution\(|\.receiveResult\(/
  );
});

test('image understanding transitions only through derived image drafts', () => {
  for (const mode of [
    'professional_image',
    'image_editing',
    'image_to_prompt'
  ]) {
    assert.match(understandingSource, new RegExp(`deriveDraft\\('${mode}'\\)`));
  }

  assert.match(understandingSource, /\.derive\(draft\.draftId, targetMode\)/);
  assert.match(appSource, /activeSubItemId === 'image-understanding'/);
  assert.match(understandingSource, /没有创建或提交任务/);
});
