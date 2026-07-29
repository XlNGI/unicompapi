import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const professionalSource = await readFile(
  'src/pages/creation/image/ImageProfessionalWorkspace.tsx',
  'utf8'
);
const controlsSource = await readFile(
  'src/pages/creation/image/ImageGenerationControls.tsx',
  'utf8'
);
const workbenchSource = await readFile(
  'src/pages/creation/image/ImageWorkbenchPage.tsx',
  'utf8'
);
const selectorSource = await readFile(
  'src/pages/creation/WorkspaceContextSelector.tsx',
  'utf8'
);
const submissionFlowSource = await readFile(
  'src/pages/creation/image/useImageSubmissionFlow.ts',
  'utf8'
);
const source = `${professionalSource}\n${controlsSource}\n${selectorSource}\n${submissionFlowSource}`;

test('professional image keeps each context source distinct and honest', () => {
  for (const text of [
    '项目素材',
    '项目上下文',
    '已保存的对话',
    '单张参考图',
    '参考图用途',
    '候选只在点击后读取',
    '保存草稿不构成向服务商外发授权'
  ]) {
    assert.match(source, new RegExp(text));
  }

  for (const kind of [
    'project_asset',
    'project_context',
    'saved_conversation'
  ]) {
    assert.match(selectorSource, new RegExp(`kind: '${kind}'`));
  }
  assert.match(professionalSource, /WorkspaceContextSelector/);
});

test('professional image preserves the three prompt layers and dynamic facts', () => {
  for (const text of [
    '用户原始输入',
    '系统补充内容',
    '最终提交提示词',
    '没有真实增强结果',
    '图片生成模型',
    '检查提交条件',
    '逐项确认本次提交',
    '费用状态：未知'
  ]) {
    assert.match(source, new RegExp(text));
  }

  assert.match(source, /parameterSchema\?\.fields\.map/);
  assert.match(professionalSource, /systemSupplements/);
  assert.match(professionalSource, /finalPrompt/);
});

test('professional image uses only controlled local input and preflight', () => {
  for (const operation of ['selectInput', 'createInputPreview', 'preflight']) {
    assert.match(professionalSource, new RegExp(`\\.${operation}\\(`));
  }

  assert.match(workbenchSource, /ImageProfessionalWorkspace/);
  assert.match(professionalSource, /提交图片生成/);
  assert.match(professionalSource, /只有已验证并启用的协议能力/);
  assert.doesNotMatch(
    source,
    /fetch\(|localStorage|absolutePath|upload|OpenAI|Midjourney|1024x1024|45%/
  );
});
