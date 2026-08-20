import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const paths = [
  'src/pages/creation/image/ImageQuickWorkspace.tsx',
  'src/pages/creation/video/VideoQuickWorkspace.tsx'
];

test('image and video workspaces show real submit stages in the shared preview', async () => {
  for (const path of paths) {
    const source = await readFile(path, 'utf8');
    assert.match(source, /onProgressChange=\{handleProgressChange\}/);
    assert.match(source, /loading=\{generationInFlight\}/);
    assert.match(source, /loadingTitle=\{generationPreviewCopy\.title\}/);
  }
});

test('professional image shows real submit stages in its history preview', async () => {
  const workspace = await readFile(
    'src/pages/creation/image/ImageProfessionalWorkspace.tsx',
    'utf8'
  );
  const history = await readFile(
    'src/components/GenerationHistory.tsx',
    'utf8'
  );
  assert.match(workspace, /onProgressChange={handleProgressChange}/);
  assert.match(workspace, /submissionProgress={submissionProgress}/);
  assert.match(history, /livePendingPhases/);
  assert.match(history, /const showLoadingPreview = generationInFlight && !selectedWorkId/);
  assert.match(history, /loading={showLoadingPreview}/);
  assert.match(history, /mediaKind === 'image' \? '图片' : '视频'/);
});

test('professional image and video share real submit stages in generation history', async () => {
  const history = await readFile('src/components/GenerationHistory.tsx', 'utf8');
  for (const path of [
    'src/pages/creation/image/ImageProfessionalWorkspace.tsx',
    'src/pages/creation/video/VideoTextWorkspace.tsx',
    'src/pages/creation/video/VideoImageWorkspace.tsx'
  ]) {
    const source = await readFile(path, 'utf8');
    assert.match(source, /onProgressChange={handleProgressChange}/);
    assert.match(source, /<GenerationHistory/);
    assert.match(source, /submissionProgress={submissionProgress}/);
  }
  assert.match(history, /const showLoadingPreview = generationInFlight && !selectedWorkId/);
  assert.match(history, /loading={showLoadingPreview}/);
  assert.match(history, /mediaKind={mediaKind}/);
});

test('accepted asynchronous work remains visible while the provider is processing it', async () => {
  for (const path of paths) {
    const source = await readFile(path, 'utf8');
    const callback = source.slice(
      source.indexOf('onSubmissionComplete={(submission) =>'),
      source.indexOf('}}', source.indexOf('onSubmissionComplete={(submission) =>'))
    );
    assert.match(callback, /submission\.status === 'completed'/);
    assert.doesNotMatch(callback, /provider_accepted/);
  }
});

test('the video submit panel exposes stages without coupling them to progress-step visibility', async () => {
  const source = await readFile(
    'src/pages/creation/video/VideoFeatureSubmissionPanel.tsx',
    'utf8'
  );
  assert.match(source, /readonly onProgressChange\?:/);
  assert.match(source, /const trackProgress = showProgressSteps \|\| Boolean\(onProgressChange\);/);
  assert.match(source, /onProgressChange\?\.\(progressPhase, progressFailure\)/);
});
