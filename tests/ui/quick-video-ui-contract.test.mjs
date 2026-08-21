import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const quick = await readFile('src/pages/creation/video/VideoQuickWorkspace.tsx', 'utf8');
const panel = await readFile('src/pages/creation/video/VideoFeatureSubmissionPanel.tsx', 'utf8');
const shell = await readFile('src/pages/creation/video/VideoWorkbenchPage.tsx', 'utf8');
const bundle = `${quick}\n${panel}\n${shell}`;

test('quick video is fixed to text-to-video with no material or context input', () => {
  assert.match(quick, /productFeature: 'text_to_video'/);
  assert.match(quick, /0 份图片素材 · 0 份视频素材 · 0 份上下文/);
  assert.doesNotMatch(quick, /selectMaterial\(|getMaterial\(|clearMaterial\(|createMaterialPreview\(/);
  assert.doesNotMatch(quick, /WorkspaceContextSelector|acceptedMediaKinds|quickReferenceTarget/);
});

test('quick video migrates legacy drafts explicitly without silently clearing them', () => {
  assert.match(quick, /legacyReference/);
  assert.match(quick, /\.derive\(draft\.draftId, targetMode\)/);
  assert.match(quick, /'image_to_video'/);
  assert.match(quick, /'text_to_video'/);
  assert.doesNotMatch(quick, /quick:\s*\{\}/);
});

test('quick video has one safe feature submission flow', () => {
  assert.match(quick, /VideoFeatureSubmissionPanel/);
  assert.match(quick, /onDraftPersisted/);
  assert.match(quick, /showProgressSteps/);
  assert.match(panel, /listCandidates/);
  assert.match(panel, /prepareSubmission/);
  assert.match(panel, /submitDraft/);
  assert.match(panel, /persistVideoWorkspaceDraft/);
  assert.doesNotMatch(bundle, /createTask\(|createExecution\(|invokeExecution\(|preflight\(/);
  assert.doesNotMatch(bundle, /fetch\(|localStorage|absolutePath|remoteOperationId|upload\(/);
});

test('quick video hides dynamic parameters and uses provider defaults', () => {
  assert.match(quick, /oneShot/);
  assert.match(panel, /oneShot/);
  assert.match(panel, /快速视频使用服务默认参数/);
  assert.match(panel, /DynamicParameterForm/);
});

test('quick video keeps the shared result surface without a call-record notice', () => {
  assert.match(quick, /GenerationResultPreview/);
  assert.match(quick, /尚无生成结果/);
  assert.doesNotMatch(quick, /调用记录|快速\/文生\/图生视频共用同一提交/);
  assert.doesNotMatch(quick, /<StatusPill/);
  assert.match(panel, /runtime_not_allowed/);
  assert.doesNotMatch(panel + quick, /在线运行未授权|视频提交运行时未就绪或未获准/);
  assert.match(panel, /silentlyFinishRuntimeGate/);
  assert.doesNotMatch(panel, /notifications\.(?:show|dismiss)|generationNotificationId/);
  assert.doesNotMatch(bundle, /默认 1 个结果|16:9|1080p|24fps|Runway|Sora/);
});
