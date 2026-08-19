import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const paths = [
  'src/pages/creation/image/ImageQuickWorkspace.tsx',
  'src/pages/creation/image/ImageProfessionalWorkspace.tsx',
  'src/pages/creation/video/VideoQuickWorkspace.tsx',
  'src/pages/creation/video/VideoTextWorkspace.tsx',
  'src/pages/creation/video/VideoImageWorkspace.tsx'
];

test('image and video workspaces show real submit stages in the shared preview', async () => {
  for (const path of paths) {
    const source = await readFile(path, 'utf8');
    assert.match(source, /onProgressChange=\{handleProgressChange\}/);
    assert.match(source, /loading=\{generationInFlight\}/);
    assert.match(source, /loadingTitle=\{generationPreviewCopy\.title\}/);
  }
});

test('accepted asynchronous work remains visible while the provider is processing it', async () => {
  for (const path of paths.filter((path) => !path.includes('ImageProfessional'))) {
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
