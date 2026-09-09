import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile('src/pages/creation/video/VideoTextWorkspace.tsx', 'utf8');
const panel = await readFile('src/pages/creation/video/VideoFeatureSubmissionPanel.tsx', 'utf8');
const selector = await readFile('src/pages/creation/WorkspaceContextSelector.tsx', 'utf8');
const bundle = `${source}\n${panel}\n${selector}`;

test('text-to-video is fixed to text input and pinned project context', () => {
  assert.match(source, /productFeature !== 'text_to_video'/);
  assert.match(source, /WorkspaceContextSelector/);
  assert.match(source, /projectContextsOnly/);
  assert.match(source, /contextRevision === undefined/);
  assert.match(source, /includeInPrompt === undefined/);
  assert.match(selector, /includeInPrompt: true/);
});

test('text-to-video exposes no material selection and handles legacy slots explicitly', () => {
  assert.match(source, /removeLegacyMaterials/);
  assert.match(source, /明确移除旧素材槽位/);
  assert.doesNotMatch(source, /selectMaterial\(|getMaterial\(|createMaterialPreview\(/);
  assert.doesNotMatch(source, /schema\.materialSlots|acceptedMediaKinds/);
});

test('text-to-video can explicitly remove unsupported legacy contexts', () => {
  assert.match(source, /removeUnsupportedContexts/);
  assert.match(source, /明确移除旧上下文/);
  assert.match(source, /reference\.kind === 'project_context'/);
  assert.match(source, /reference\.contextRevision !== undefined/);
  assert.match(source, /reference\.includeInPrompt !== undefined/);
});

test('text-to-video keeps prompt editing local without shot controls', () => {
  for (const fact of ['originalInput', 'finalPrompt', '视频创意']) {
    assert.match(source, new RegExp(fact));
  }
  assert.doesNotMatch(source, /文字来源|简短创意|长文本脚本/);
  assert.doesNotMatch(source, /调用记录/);
  assert.doesNotMatch(source, /镜头计划|添加镜头|删除镜头|uc-video-text__shot/);
  assert.doesNotMatch(source, /addShot|updateShot|removeShot|emptyStoryboard/);
  assert.doesNotMatch(bundle, /fetch\(|upload\(|analy[sz]e\(|absolutePath/);
});

test('text-to-video reuses the professional image prompt tools layout', () => {
  assert.match(source, /uc-image-professional__prompt-tools/);
  assert.match(source, /<WorkspaceContextSelector\s+compact/);
  assert.match(source, /<VideoPromptEnhancePanel\s+compact/);
  assert.ok(
    source.indexOf('<WorkspaceContextSelector') < source.indexOf('<VideoPromptEnhancePanel'),
    'project context should precede prompt enhancement in the shared tool row'
  );
});

test('text-to-video reveals the final prompt only after enhancement', () => {
  assert.match(source, /enhancementContent \? \(/);
  assert.match(source, /enhancementContent \? '3' : '2'/);
});

test('text-to-video uses only the unified candidate and submission panel', () => {
  assert.match(source, /VideoFeatureSubmissionPanel/);
  assert.match(source, /showProgressSteps/);
  assert.match(source, /GenerationHistory/);
  assert.match(source, /mediaKind="video"/);
  assert.match(source, /onSubmissionComplete/);
  assert.match(panel, /routeSelectionToken/);
  assert.match(panel, /confirmationId/);
  assert.match(panel, /SubmissionProgressSteps/);
  assert.match(panel, /showProgressSteps = false/);
  assert.doesNotMatch(source, /createTask\(|createExecution\(|invokeExecution\(|preflight\(/);
});

test('text-to-video identifies and validates real required inputs locally', () => {
  assert.match(source, /uc-dynamic-parameters__required.*必填/);
  assert.match(panel, /requiredInputError/);
  assert.match(panel, /draft\.prompt\.finalPrompt\.trim\(\)\.length === 0/);
  assert.match(panel, /提示词为必填项/);
  assert.match(panel, /required/);
  assert.doesNotMatch(bundle, /可以提交/);
});
