import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const quickSource = await readFile(
  'src/pages/creation/image/ImageQuickWorkspace.tsx',
  'utf8'
);
const generationControlsSource = await readFile(
  'src/pages/creation/image/ImageGenerationControls.tsx',
  'utf8'
);
const submissionFlowSource = await readFile(
  'src/pages/creation/image/useImageSubmissionFlow.ts',
  'utf8'
);
const quickBundle = `${quickSource}\n${generationControlsSource}\n${submissionFlowSource}`;
const appSource = await readFile('src/ui/App.tsx', 'utf8');

test('quick image page uses the controlled input and preflight APIs', () => {
  for (const operation of ['selectInput', 'createInputPreview', 'preflight']) {
    assert.match(quickBundle, new RegExp(`\\.${operation}\\(`));
  }

  assert.doesNotMatch(
    quickBundle,
    /fetch\(|localStorage|absolutePath|upload|OpenAI|Midjourney|1024x1024|45%/
  );
  for (const operation of [
    'createTask',
    'createExecution',
    'invokeExecution',
    'receiveResult'
  ]) {
    assert.match(submissionFlowSource, new RegExp(`submissions\\.${operation}\\(`));
  }
});

test('quick image keeps draft, model parameters and confirmations explicit', () => {
  for (const text of [
    '一句话需求',
    '单张参考图（可选）',
    '保存本地草稿',
    '检查提交条件',
    '逐项确认本次提交',
    '费用状态：未知',
    '提交任务',
    '保存到项目',
    '重新生成',
    '进入专业创作'
  ]) {
    assert.match(
      `${quickBundle}\n${appSource}`,
      new RegExp(text.replace(/[（）]/g, '\\$&'))
    );
  }

  assert.match(generationControlsSource, /parameterSchema\?\.fields\.map/);
  assert.match(quickSource, /\.derive\([\s\S]*'professional_image'/);
  assert.match(appSource, /'quick-image'[\s\S]*'professional-image'/);
});

test('quick image keeps unavailable adapters blocked without fake output', () => {
  assert.match(generationControlsSource, /adapter_unavailable/);
  assert.match(generationControlsSource, /没有配置真实图片生成适配器/);
  assert.match(quickSource, /尚无真实生成结果/);
  assert.match(quickSource, /不会显示假进度或未校验结果/);
  assert.match(quickSource, /submission\.canCreateTask/);
});
