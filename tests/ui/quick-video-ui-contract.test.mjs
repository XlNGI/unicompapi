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
  assert.match(panel, /listCandidates/);
  assert.match(panel, /prepareSubmission/);
  assert.match(panel, /submitDraft/);
  assert.doesNotMatch(bundle, /createTask\(|createExecution\(|invokeExecution\(|preflight\(/);
  assert.doesNotMatch(bundle, /fetch\(|localStorage|absolutePath|remoteOperationId|upload\(/);
});

test('quick video reports the blocked runtime and never invents a result', () => {
  assert.match(quick, /在线运行未授权/);
  assert.match(quick, /尚无真实生成结果/);
  assert.match(panel, /runtime_not_allowed/);
  assert.doesNotMatch(bundle, /默认 1 个结果|16:9|1080p|24fps|Runway|Sora/);
});
