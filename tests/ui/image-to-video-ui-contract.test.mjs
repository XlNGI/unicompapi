import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile('src/pages/creation/video/VideoImageWorkspace.tsx', 'utf8');
const panel = await readFile('src/pages/creation/video/VideoFeatureSubmissionPanel.tsx', 'utf8');
const shell = await readFile('src/pages/creation/video/VideoWorkbenchPage.tsx', 'utf8');
const page = await readFile('src/pages/creation/video/ImageToVideoPage.tsx', 'utf8');
const bundle = `${source}\n${panel}\n${shell}`;

test('image-to-video uses exactly one controlled image source', () => {
  assert.match(source, /kind: 'image_source'/);
  assert.match(source, /selectMaterial\([\s\S]*'image'/);
  assert.match(source, /draft\.imageToVideo\.source/);
  assert.match(source, /恰好一张受控图片/);
  assert.doesNotMatch(source, /首帧|尾帧|主体参考|acceptedMediaKinds/);
});

test('image source selection stays inside controlled media APIs', () => {
  for (const operation of ['selectMaterial', 'getMaterial', 'clearMaterial', 'createMaterialPreview']) {
    assert.match(source, new RegExp(`\\.${operation}\\(`));
  }
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

test('image-to-video preserves separate prompt, requirements and context facts', () => {
  for (const field of [
    'mustKeep',
    'allowedChanges',
    'prohibited',
    'subjectAction',
    'cameraMovement',
    'pace',
    'depthOfField',
    'finalPrompt'
  ]) {
    assert.match(source, new RegExp(field));
  }
  assert.match(source, /projectContextsOnly/);
});

test('image-to-video uses the unified feature panel and opens derived drafts', () => {
  assert.match(source, /VideoFeatureSubmissionPanel/);
  assert.match(page, /preferredDraftId=\{preferredDraftId\}/);
  assert.match(shell, /drafts\.find\(\(draft\) => draft\.draftId === selectedDraftId\)/);
  assert.doesNotMatch(source, /createTask\(|createExecution\(|invokeExecution\(|preflight\(/);
});
