import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const editingSource = await readFile(
  'src/pages/creation/image/ImageEditingWorkspace.tsx',
  'utf8'
);
const controlsSource = await readFile(
  'src/pages/creation/image/ImageGenerationControls.tsx',
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
const source = `${editingSource}\n${controlsSource}\n${regionSource}`;

test('image editing keeps source, region, mask and requirements explicit', () => {
  for (const text of [
    '单张原图',
    '原始编辑要求',
    '必须保留内容',
    '必须修改内容',
    '禁止出现内容',
    '启用编辑区域',
    '可选蒙版',
    '尚未提供受控蒙版选择接口'
  ]) {
    assert.match(source, new RegExp(text));
  }

  for (const field of ['mustKeep', 'mustChange', 'prohibited', 'maskAssetId']) {
    assert.match(editingSource, new RegExp(field));
  }
});

test('image editing uses controlled media and dynamic preflight facts', () => {
  for (const operation of [
    'selectInput',
    'getInput',
    'createInputPreview',
    'preflight'
  ]) {
    assert.match(editingSource, new RegExp(`\\.${operation}\\(`));
  }

  for (const text of [
    '图片编辑模型',
    '检查编辑条件',
    '最终编辑要求',
    '没有真实图片编辑适配器'
  ]) {
    assert.match(source, new RegExp(text));
  }

  assert.match(controlsSource, /purpose="image_editing"/);
  assert.match(controlsSource, /parameterSchema\?\.fields\.map/);
  assert.match(workbenchSource, /ImageEditingWorkspace/);
  assert.doesNotMatch(
    source,
    /fetch\(|localStorage|absolutePath|upload|\.createTask\(|\.createExecution\(|\.invokeExecution\(|\.receiveResult\(/
  );
});

test('image editing preserves lineage and derives without overwriting', () => {
  for (const text of [
    '版本关系',
    '源 Asset',
    '父草稿',
    '父作品',
    '原图保持不变',
    '保存新版本到项目',
    '继续编辑新分支'
  ]) {
    assert.match(editingSource, new RegExp(text));
  }

  assert.match(editingSource, /\.derive\(draft\.draftId, targetMode\)/);
  assert.match(editingSource, /deriveDraft\('image_to_prompt'\)/);
  assert.match(editingSource, /deriveDraft\('professional_image'\)/);
  assert.match(editingSource, /没有创建或提交任务/);
});
