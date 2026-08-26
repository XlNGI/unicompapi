import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const quickSource = await readFile(
  'src/pages/creation/image/ImageQuickWorkspace.tsx',
  'utf8'
);
const featurePanelSource = await readFile(
  'src/pages/creation/image/ImageFeatureSubmissionPanel.tsx',
  'utf8'
);
const workbenchSource = await readFile(
  'src/pages/creation/image/ImageWorkbenchPage.tsx',
  'utf8'
);
const pageStyles = await readFile('src/styles/pages.css', 'utf8');
const previewSource = await readFile(
  'src/components/GenerationResultPreview.tsx',
  'utf8'
);
const autosaveSource = await readFile(
  'src/application/latest-snapshot-autosave.ts',
  'utf8'
);
const source = `${quickSource}\n${featurePanelSource}`;

test('quick image is pure text-to-image with no material or context entry', () => {
  assert.match(quickSource, /productFeature: 'text_to_image'/);
  assert.match(quickSource, /0 份图片素材 · 0 份上下文/);
  assert.doesNotMatch(
    quickSource,
    /selectInput|createInputPreview|WorkspaceContextSelector|LuImagePlus|添加参考|选择参考|单张参考/
  );
  assert.doesNotMatch(quickSource, /imageSubmissions|ProviderRegistry|CapabilityEvidence/);
  assert.match(workbenchSource, /isQuickImage \? '文字需求' : '输入与上下文'/);
  assert.match(
    workbenchSource,
    /快速生图固定为纯文生图，不接收图片或上下文。/
  );
  assert.match(
    workbenchSource,
    /isQuickImage[\s\S]*创建项目内草稿后，可填写文字需求并检查真实提交条件。/
  );
  assert.match(workbenchSource, /isQuickImage \? '结果预览' : '画布与预览'/);
  assert.match(
    workbenchSource,
    /创建项目内草稿后，这里将显示通过本地校验并登记的真实生成结果。/
  );
});

test('legacy quick drafts can only derive into professional creation', () => {
  assert.match(quickSource, /const legacyReason = draft\.input/);
  assert.match(quickSource, /旧草稿需要迁移/);
  assert.match(quickSource, /\.derive\([\s\S]*'professional_image'/);
  assert.match(quickSource, /blockedReason=\{legacyReason\}/);
  assert.doesNotMatch(quickSource, /clearInput\(|selectInput\(/);
});

test('quick image uses the safe feature DTO and one business submission action', () => {
  assert.match(quickSource, /ImageFeatureSubmissionPanel/);
  for (const operation of ['listCandidates', 'prepareSubmission', 'submitDraft']) {
    assert.match(featurePanelSource, new RegExp(`api\\.${operation}\\(`));
  }
  assert.match(featurePanelSource, /DynamicParameterForm/);
  assert.match(featurePanelSource, /服务商 \/ 连接 \/ 模型/);
  assert.doesNotMatch(featurePanelSource, /<fieldset className="uc-image-quick__confirmations"/);
  assert.doesNotMatch(featurePanelSource, /<Checkbox|setConfirmed|确认并提交/);
  assert.match(
    featurePanelSource,
    /api\.prepareSubmission\([\s\S]*await submitPrepared\(saved, result\.value\)/
  );
  assert.doesNotMatch(featurePanelSource, /defaultParameterValues|ImageGenerationModelFields/);
  assert.doesNotMatch(
    source,
    /创建图片任务|创建执行记录|createTask\(|createExecution\(|invokeExecution\(|receiveResult\(/
  );
});

test('quick image synchronously blocks duplicate one-shot submissions', () => {
  const start = featurePanelSource.indexOf('async function generateOneShot()');
  const end = featurePanelSource.indexOf('\n  return (', start);
  const oneShot = featurePanelSource.slice(start, end);
  assert.match(oneShot, /if \(busyRef\.current\) return/);
  assert.match(oneShot, /busyRef\.current = true;[\s\S]*api\.generateQuickImage\(/);
  assert.match(oneShot, /finally \{[\s\S]*busyRef\.current = false;/);
});

test('quick image loads model candidates before prompt entry', () => {
  assert.doesNotMatch(
    featurePanelSource,
    /if \(oneShot && draft\.prompt\.finalPrompt\.trim\(\)\.length === 0\) \{[\s\S]*setCandidates\(\[\]\)/
  );
  assert.match(featurePanelSource, /api\.listCandidates\(draftId, draftUpdatedAt\)/);
  assert.match(featurePanelSource, /if \(prompt\.length === 0\) \{[\s\S]*showGenerationError/);
});

test('quick image autosave coalesces edits behind one in-flight save', () => {
  assert.match(workbenchSource, /useLatestSnapshotAutosave/);
  assert.match(workbenchSource, /debounceMs: 1_000/);
  assert.match(autosaveSource, /private inFlight\?/);
  assert.match(autosaveSource, /private pending\?/);
  assert.match(autosaveSource, /snapshot: this\.options\.rebase\(pending\.snapshot, result\.value\)/);
  assert.doesNotMatch(featurePanelSource, /draftRef\.current !== snapshot/);
  const needsSaveBlock = featurePanelSource.match(/if \(needsSave\) \{[\s\S]*?return;\s*\}/)?.[0];
  assert.ok(needsSaveBlock, 'autosave guard is missing');
  assert.doesNotMatch(needsSaveBlock, /setLoadState\(/);
  assert.doesNotMatch(needsSaveBlock, /setCandidates\(\[\]\)/);
});

test('quick image keeps input, model, and result areas in workflow order', () => {
  const composerIndex = quickSource.indexOf('uc-image-quick__composer');
  const inspectorIndex = quickSource.indexOf('uc-image-quick__inspector');
  const stageIndex = quickSource.indexOf('uc-image-quick__stage');
  assert.ok(composerIndex >= 0, 'quick image composer is missing');
  assert.ok(inspectorIndex > composerIndex, 'step 2 must follow step 1');
  assert.ok(stageIndex > inspectorIndex, 'step 3 must follow step 2');
  assert.match(quickSource.slice(composerIndex, inspectorIndex), /输入一句话生成图片/);
  assert.match(quickSource.slice(inspectorIndex, stageIndex), /模型与生成/);
  assert.match(quickSource.slice(stageIndex), /生成结果/);
});

test('quick image result preview stays compact without stretching the image', () => {
  assert.match(
    pageStyles,
    /\.uc-image-quick__stage \.uc-image-quick__result-item img \{[\s\S]*max-height: 322px;[\s\S]*object-fit: contain;/
  );
});

test('quick image keeps the result canvas free of a duplicate heading', () => {
  assert.match(
    pageStyles,
    /\.uc-generation-two-pane__result > \.uc-image-quick__stage > \.uc-image-workbench__panel-heading \{\s*display: none;/
  );
  assert.match(
    pageStyles,
    /\.uc-generation-two-pane__result > \.uc-image-quick__stage > \.uc-image-quick__result-actions \{[\s\S]*border-top: 1px solid var\(--uc-color-border-subtle\);/
  );
});

test('quick image exposes the registered local result without duplicating download logic', () => {
  assert.match(quickSource, /storage\.revealWorkFile\(workId\)/);
  assert.match(quickSource, /打开图片位置/);
  assert.match(quickSource, /disabled=\{!storage \|\| !workId \|\| revealing\}/);
  assert.doesNotMatch(quickSource, /<a[^>]+download|fetch\(/);
});

test('quick image keeps unavailable runtime blocked without fake output', async () => {
  assert.match(featurePanelSource, /runtime_not_allowed/);
  assert.doesNotMatch(featurePanelSource, /在线图片运行尚未获准|在线运行未授权/);
  assert.match(featurePanelSource, /silentlyFinishRuntimeGate/);
  assert.doesNotMatch(featurePanelSource, /notifications\.(?:show|dismiss)|generationNotificationId/);
  assert.match(featurePanelSource, /!selectedCandidate\?\.available/);
  assert.match(quickSource, /生成结果将在这里显示/);
  assert.match(quickSource, /GenerationResultPreview/);
  assert.match(previewSource, /createWorkMediaHandle/);
  assert.doesNotMatch(
    source,
    /fetch\(|localStorage|absolutePath|upload|OpenAI|Midjourney|1024x1024|45%/
  );
});

test('quick image omits the redundant call-record notice', () => {
  assert.doesNotMatch(quickSource, /<StatusPill[^>]*>调用记录<\/StatusPill>/);
});

test('quick image copy follows prompt, model, then generate workflow', () => {
  assert.match(quickSource, /描述想生成的画面/);
  assert.match(quickSource, /输入提示词，选择模型，然后点击生成。/);
  assert.match(quickSource, /生成结果将在这里显示/);
  assert.doesNotMatch(quickSource, />3<\/span>/);
  assert.match(featurePanelSource, /尚未配置可用模型/);
  assert.match(featurePanelSource, /添加并启用图像模型/);
  assert.match(featurePanelSource, /当前输入不适用于所选模型/);
});

test('quick image uses the compact result presentation', () => {
  assert.match(quickSource, /<GenerationResultPreview[\s\S]*compact/);
  assert.match(previewSource, /readonly compact\?: boolean/);
  assert.match(previewSource, /compact \? null : <strong>本地作品预览<\/strong>/);
});

test('workbench does not pass the old provider registry into quick image', () => {
  const start = workbenchSource.indexOf('<ImageQuickWorkspace');
  const end = workbenchSource.indexOf('/>', start);
  const invocation = workbenchSource.slice(start, end);
  assert.doesNotMatch(invocation, /registry=|onVideoDraftCreated/);
});
