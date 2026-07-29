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
const workbenchSource = await readFile(
  'src/pages/creation/image/ImageWorkbenchPage.tsx',
  'utf8'
);
const professionalSource = await readFile(
  'src/pages/creation/image/ImageProfessionalWorkspace.tsx',
  'utf8'
);
const editingSource = await readFile(
  'src/pages/creation/image/ImageEditingWorkspace.tsx',
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
    '输入一句话，UniComp AI 为你生成图片',
    '单张参考图（可选）',
    '保存本地草稿',
    '检查并准备生成',
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
  assert.doesNotMatch(workbenchSource, /uc-image-workbench__mode-switch/);
});

test('quick image keeps the visible work areas in 1, 2, 3 order', () => {
  const composerIndex = quickSource.indexOf('uc-image-quick__composer');
  const inspectorIndex = quickSource.indexOf('uc-image-quick__inspector');
  const stageIndex = quickSource.indexOf('uc-image-quick__stage');

  assert.ok(composerIndex >= 0, 'quick image composer is missing');
  assert.ok(inspectorIndex > composerIndex, 'step 2 must follow step 1');
  assert.ok(stageIndex > inspectorIndex, 'step 3 must follow step 2');
  assert.match(
    quickSource.slice(composerIndex, inspectorIndex),
    /<span aria-hidden="true">1<\/span>/
  );
  assert.match(
    quickSource.slice(inspectorIndex, stageIndex),
    /<span aria-hidden="true">2<\/span>/
  );
  assert.match(
    quickSource.slice(stageIndex),
    /<span aria-hidden="true">3<\/span>/
  );
});

test('quick image keeps unavailable adapters blocked without fake output', () => {
  const composerIndex = quickSource.indexOf('uc-image-quick__composer');
  const stageIndex = quickSource.indexOf('uc-image-quick__stage');
  const composerSource = quickSource.slice(composerIndex, stageIndex);
  const stageSource = quickSource.slice(stageIndex);

  assert.match(generationControlsSource, /adapter_unavailable/);
  assert.match(generationControlsSource, /没有配置真实图片生成适配器/);
  assert.match(composerSource, /src=\{inputPreviewUrl\}/);
  assert.doesNotMatch(stageSource, /inputPreviewUrl|参考图：/);
  assert.match(quickSource, /尚无真实生成结果/);
  assert.match(quickSource, /不会显示假进度或未校验结果/);
  assert.match(quickSource, /submission\.canCreateTask/);
});

test('image Work handoff opens only the derived image-to-video draft', () => {
  const handoffStart = submissionFlowSource.indexOf(
    'async function createVideoDraft'
  );
  const handoffEnd = submissionFlowSource.indexOf(
    'function reportError',
    handoffStart
  );
  const handoffSource = submissionFlowSource.slice(handoffStart, handoffEnd);

  assert.match(handoffSource, /createFromImageWork\(work\.workId\)/);
  assert.match(
    handoffSource,
    /onVideoDraftCreated\?\.\(result\.value\.draftId\)/
  );
  assert.doesNotMatch(
    handoffSource,
    /submissions\.(createTask|createExecution|invokeExecution)/
  );
  assert.match(
    appSource,
    /setOpenedVideoDraftId\(draftId\)[\s\S]*setActiveItemId\('video-creation'\)[\s\S]*setActiveSubItemId\('image-to-video'\)/
  );
});

test('image task and execution creation are disabled after they exist', () => {
  assert.match(
    submissionFlowSource,
    /allConfirmed\(options\.confirmations\)[\s\S]*!task[\s\S]*!options\.busy/
  );
  assert.match(
    submissionFlowSource,
    /if \(!submissions \|\| !task \|\| execution \|\| options\.busy\) return/
  );
  for (const source of [quickSource, professionalSource, editingSource]) {
    assert.match(
      source,
      /disabled=\{!submission\.task \|\| Boolean\(submission\.execution\) \|\| busy\}/
    );
  }
});
