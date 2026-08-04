import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const promptSource = await readFile(
  'src/pages/creation/image/ImageToPromptWorkspace.tsx',
  'utf8'
);
const regionSource = await readFile(
  'src/pages/creation/image/ImageRegionFields.tsx',
  'utf8'
);
const workbenchSource = await readFile(
  'src/pages/creation/image/ImageWorkbenchPage.tsx',
  'utf8'
);
const appSource = await readFile('src/ui/App.tsx', 'utf8');
const source = `${promptSource}\n${regionSource}`;

test('image to prompt covers before, current and stale analysis states', () => {
  for (const text of [
    '图片已加载，尚未分析',
    '分析结果有效',
    '分析结果已过期',
    '旧分析与旧草稿仅供参考',
    '源图片已变化',
    '分析区域已变化',
    '目标用途已变化',
    '补充要求已变化'
  ]) {
    assert.match(promptSource, new RegExp(text));
  }

  assert.match(workbenchSource, /imageToPrompt\.analysisState === 'stale'/);
});

test('image to prompt separates facts, inference, uncertainty and editable draft', () => {
  for (const text of [
    '图片可见事实',
    '模型推断',
    '不确定项',
    '无法识别',
    '系统补充',
    '最终提示词草稿（可编辑）',
    '提示词草稿不是作品'
  ]) {
    assert.match(promptSource, new RegExp(text.replace(/[（）]/g, '\\$&')));
  }

  for (const field of [
    'visibleFacts',
    'modelInferences',
    'uncertainties',
    'unrecognized',
    'systemSupplements',
    'finalPrompt'
  ]) {
    assert.match(promptSource, new RegExp(field));
  }
});

test('image to prompt uses controlled input, preflight and derived drafts only', () => {
  for (const operation of [
    'selectInput',
    'getInput',
    'createInputPreview',
    'preflight'
  ]) {
    assert.match(promptSource, new RegExp(`\\.${operation}\\(`));
  }

  for (const text of [
    '目标用途',
    '补充要求',
    '启用分析区域',
    '检查分析条件',
    '没有真实图片转提示词适配器'
  ]) {
    assert.match(source, new RegExp(text));
  }

  assert.match(
    promptSource,
    /\.deriveFromResult\([\s\S]*draft\.draftId,[\s\S]*analysis\.resultRevision,[\s\S]*targetMode/
  );
  assert.match(promptSource, /deriveDraft\('professional_image'\)/);
  assert.match(promptSource, /deriveDraft\('image_editing'\)/);
  assert.match(workbenchSource, /ImageToPromptWorkspace/);
  assert.match(appSource, /activeSubItemId === 'image-to-prompt'/);
  assert.doesNotMatch(
    source,
    /fetch\(|localStorage|absolutePath|upload|\.createTask\(|\.createExecution\(|\.invokeExecution\(|\.receiveResult\(/
  );
});
