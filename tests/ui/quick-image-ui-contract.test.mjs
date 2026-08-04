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
  assert.match(featurePanelSource, /blockedReason && !isQuick/);
  assert.doesNotMatch(quickSource, /clearInput\(|selectInput\(/);
});

test('quick image keeps separate complete cards without a broken accent frame', () => {
  assert.match(quickSource, /rows=\{4\}/);
  assert.match(pageStyles, /\.uc-image-quick__workspace[\s\S]*gap: var\(--uc-space-3\)/);
  assert.doesNotMatch(pageStyles, /border-bottom-color: transparent/);
  assert.match(pageStyles, /@container \(min-width: 1181px\)[\s\S]*"composer stage"[\s\S]*"inspector stage"/);
  assert.match(
    pageStyles,
    /data-mode="quick_image"\] \.uc-image-workbench__header[\s\S]*width: min\(100%, 1080px\)/
  );
  assert.match(
    pageStyles,
    /@container \(min-width: 1181px\)[\s\S]*data-mode="quick_image"\] \.uc-image-workbench__workspace[\s\S]*grid-template-columns: minmax\(0, 1\.15fr\) minmax\(380px, 0\.85fr\)/
  );
});

test('quick image uses the safe feature DTO and one business submission action', () => {
  assert.match(quickSource, /ImageFeatureSubmissionPanel/);
  for (const operation of ['listCandidates', 'prepareSubmission', 'submitDraft']) {
    assert.match(featurePanelSource, new RegExp(`api\\.${operation}\\(`));
  }
  assert.match(featurePanelSource, /生成模型/);
  assert.match(featurePanelSource, /isQuick/);
  assert.match(featurePanelSource, /确认本次外发/);
  assert.match(featurePanelSource, /确认并\$\{imageActionLabel/);
  assert.doesNotMatch(featurePanelSource, /defaultParameterValues|ImageGenerationModelFields/);
  assert.doesNotMatch(
    source,
    /创建图片任务|创建执行记录|createTask\(|createExecution\(|invokeExecution\(|receiveResult\(/
  );
});

test('quick image keeps the visible work areas in 1, 2, 3 order', () => {
  const composerIndex = quickSource.indexOf('uc-image-quick__composer');
  const inspectorIndex = quickSource.indexOf('uc-image-quick__inspector');
  const stageIndex = quickSource.indexOf('uc-image-quick__stage');
  assert.ok(composerIndex >= 0, 'quick image composer is missing');
  assert.ok(inspectorIndex > composerIndex, 'step 2 must follow step 1');
  assert.ok(stageIndex > inspectorIndex, 'step 3 must follow step 2');
  assert.match(quickSource.slice(composerIndex, inspectorIndex), />1</);
  assert.match(quickSource.slice(inspectorIndex, stageIndex), />2</);
  assert.match(quickSource.slice(stageIndex), />3</);
});

test('quick image keeps unavailable runtime blocked without fake output', () => {
  assert.match(featurePanelSource, /runtime_not_allowed/);
  assert.match(featurePanelSource, /在线图片运行尚未获准，没有发出请求/);
  assert.match(quickSource, /尚无真实生成结果/);
  assert.match(quickSource, /不会创建请求、费用或假结果/);
  assert.doesNotMatch(
    source,
    /fetch\(|localStorage|absolutePath|upload|OpenAI|Midjourney|1024x1024|45%/
  );
});

test('workbench does not pass the old provider registry into quick image', () => {
  const start = workbenchSource.indexOf('<ImageQuickWorkspace');
  const end = workbenchSource.indexOf('/>', start);
  const invocation = workbenchSource.slice(start, end);
  assert.doesNotMatch(invocation, /registry=|onVideoDraftCreated/);
});

test('quick image auto-saves text before model selection without overwriting newer edits', () => {
  assert.match(workbenchSource, /isQuickImage[\s\S]*setTimeout/);
  assert.match(workbenchSource, /saveDraft\(currentDraft, true\)/);
  assert.match(workbenchSource, /latestDraftRef\.current !== draftToSave/);
});

test('quick image prepares its local draft so the model selector is not hidden behind engineering setup', () => {
  assert.match(
    workbenchSource,
    /isQuickImage && modeDrafts\.length === 0[\s\S]*imageWorkspaces\.create\('quick_image'\)/
  );
  assert.match(featurePanelSource, /<span>生成模型<\/span>/);
});
