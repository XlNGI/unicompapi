import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile('src/pages/creation/video/VideoImageWorkspace.tsx', 'utf8');
const panel = await readFile('src/pages/creation/video/VideoFeatureSubmissionPanel.tsx', 'utf8');
const shell = await readFile('src/pages/creation/video/VideoWorkbenchPage.tsx', 'utf8');
const page = await readFile('src/pages/creation/video/ImageToVideoPage.tsx', 'utf8');
const bundle = `${source}\n${panel}\n${shell}`;

test('image-to-video omits the redundant call-record notice', () => {
  assert.doesNotMatch(source, /调用记录|快速\/文生\/图生视频共用同一提交/);
  assert.doesNotMatch(source, /<StatusPill/);
});

test('image-to-video uses exactly one controlled image source', () => {
  assert.match(source, /kind: 'image_source'/);
  assert.match(source, /selectMaterial\([\s\S]*'image'/);
  assert.match(source, /draft\.imageToVideo\.source/);
  assert.match(source, /恰好一张受控图片/);
  assert.doesNotMatch(source, /尾帧|主体参考|acceptedMediaKinds/);
  assert.match(
    source,
    /uc-image-professional__prompt-input has-reference[\s\S]*ControlledImageDropZone/
  );
  assert.match(source, /uc-image-professional__placeholder/);
  assert.match(source, /<LuPlus aria-hidden="true" \/>/);
  assert.match(source, /uc-image-professional__preview-overlay/);
  assert.match(source, /aria-label="删除图片"/);
  assert.doesNotMatch(source, /uc-image-quick__reference|uc-image-quick__preview/);
});

test('image source selection stays inside controlled media APIs', () => {
  for (const operation of ['selectMaterial', 'getMaterial', 'clearMaterial', 'createMaterialPreview']) {
    assert.match(source, new RegExp(`\\.${operation}\\(`));
  }
  assert.match(source, /selectMaterial\([\s\S]*createMaterialPreview\(/);
  assert.match(
    source,
    /selectMaterial\([\s\S]*?onDraftPersisted\(result\.value\.draft/
  );
  assert.match(
    source,
    /importMaterial\([\s\S]*?onDraftPersisted\(result\.value\.draft/
  );
  assert.match(
    source,
    /clearMaterial\([\s\S]*?onDraftPersisted\(result\.value/
  );
  assert.doesNotMatch(bundle, /absolutePath|remoteOperationId|upload\(|analy[sz]e\(|fetch\(/);
});

test('legacy dynamic slots require an explicit migration action', () => {
  assert.match(source, /migrateLegacyMaterials/);
  assert.match(source, /明确迁移旧素材/);
  assert.match(source, /uniqueSelections/);
  assert.match(source, /materials: undefined/);
});

test('image-to-video can explicitly remove unsupported legacy contexts', () => {
  assert.match(source, /removeUnsupportedContexts/);
  assert.match(source, /明确移除旧上下文/);
  assert.match(source, /reference\.kind === 'project_context'/);
  assert.match(source, /reference\.contextRevision !== undefined/);
  assert.match(source, /reference\.includeInPrompt !== undefined/);
});

test('image-to-video keeps prompt and context without redundant motion controls', () => {
  assert.match(source, /finalPrompt/);
  assert.match(source, /projectContextsOnly/);
  assert.doesNotMatch(
    source,
    /主体动作|镜头运动|节奏|景深|必须保持|允许变化|禁止变化/
  );
  assert.doesNotMatch(
    source,
    /TextField|ListField|subjectAction|cameraMovement|depthOfField|mustKeep|allowedChanges|prohibited/
  );
});

test('image-to-video mirrors professional image prompt progression', () => {
  assert.match(source, /<h2>创作输入<\/h2>/);
  assert.match(source, /className="uc-image-professional__prompt-textarea"/);
  assert.match(source, /enhancementContent \? \(/);
  assert.match(source, /<h2>最终提示词<\/h2>/);
  assert.match(source, /enhancementContent \? '3' : '2'/);
  assert.match(source, /恢复原始输入/);
});

test('image-to-video reuses the professional image prompt tools layout', () => {
  assert.match(source, /uc-image-professional__prompt-tools/);
  assert.match(source, /<WorkspaceContextSelector\s+compact/);
  assert.match(source, /<VideoPromptEnhancePanel\s+compact/);
  assert.ok(
    source.indexOf('<WorkspaceContextSelector') < source.indexOf('<VideoPromptEnhancePanel'),
    'project context should precede prompt enhancement in the shared tool row'
  );
});

test('image-to-video uses the unified feature panel and opens derived drafts', () => {
  assert.match(source, /VideoFeatureSubmissionPanel/);
  assert.match(source, /showProgressSteps/);
  assert.match(source, /GenerationHistory/);
  assert.match(source, /mediaKind="video"/);
  assert.match(source, /createWorkMediaHandle|onSubmissionComplete/);
  assert.match(panel, /SubmissionProgressSteps/);
  assert.match(page, /preferredDraftId=\{preferredDraftId\}/);
  assert.match(shell, /drafts\.find\(\(draft\) => draft\.draftId === selectedDraftId\)/);
  assert.match(shell, /usesFlowAutosave/);
  assert.doesNotMatch(source, /createTask\(|createExecution\(|invokeExecution\(|preflight\(/);
});

test('image-to-video identifies and validates real required inputs locally', () => {
  assert.match(source, /首帧图片必填/);
  assert.match(source, /uc-dynamic-parameters__required.*必填/);
  assert.match(panel, /draft\.mode === 'image_to_video' && !draft\.imageToVideo\.source/);
  assert.match(panel, /首帧图片为必填项/);
  assert.doesNotMatch(bundle, /可以提交/);
});
