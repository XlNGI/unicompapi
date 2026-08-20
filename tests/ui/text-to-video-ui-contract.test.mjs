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

test('text-to-video keeps prompt and shot planning local', () => {
  for (const fact of ['originalInput', 'finalPrompt', 'shots', '添加镜头']) {
    assert.match(source, new RegExp(fact));
  }
  assert.doesNotMatch(source, /文字来源|简短创意|长文本脚本/);
  assert.doesNotMatch(source, /调用记录/);
  assert.ok(
    source.indexOf('添加镜头') < source.indexOf('<h2>最终提示词</h2>'),
    'shot planning should appear before the final prompt step'
  );
  assert.match(source, /emptyStoryboard/);
  assert.doesNotMatch(bundle, /fetch\(|upload\(|analy[sz]e\(|absolutePath/);
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
