import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sources = await Promise.all([
  'src/pages/creation/image/ImageQuickWorkspace.tsx',
  'src/pages/creation/image/ImageProfessionalWorkspace.tsx',
  'src/pages/creation/video/VideoQuickWorkspace.tsx',
  'src/pages/creation/video/VideoTextWorkspace.tsx',
  'src/pages/creation/video/VideoImageWorkspace.tsx'
].map(async (path) => ({ path, source: await readFile(path, 'utf8') })));
const styles = await readFile('src/styles/pages.css', 'utf8');
const componentStyles = await readFile('src/styles/components.css', 'utf8');
const outputPanel = await readFile('src/components/GenerationOutputPanel.tsx', 'utf8');
const appLayout = await readFile('src/ui/layout/AppLayout.tsx', 'utf8');
const imageFeaturePanel = await readFile('src/pages/creation/image/ImageFeatureSubmissionPanel.tsx', 'utf8');
const imageWorkbench = await readFile('src/pages/creation/image/ImageWorkbenchPage.tsx', 'utf8');
const videoWorkbench = await readFile('src/pages/creation/video/VideoWorkbenchPage.tsx', 'utf8');

test('image and video generation pages use the shared two-pane workbench', () => {
  for (const { path, source } of sources) {
    assert.match(source, /uc-generation-two-pane/, `${path} should use the two-pane shell`);
  }

  for (const { path, source } of sources.filter(({ path }) => !path.includes('ImageProfessional'))) {
    assert.match(source, /uc-generation-two-pane__controls/, `${path} should expose a parameter zone`);
    assert.match(source, /uc-generation-two-pane__result/, `${path} should expose a generation-content zone`);
  }
});

test('the shared generation workbench keeps parameters left and generated content right', () => {
  assert.match(
    styles,
    /\.uc-generation-two-pane \{[\s\S]*grid-template-columns: minmax\(340px, 0\.9fr\) minmax\(520px, 1\.35fr\);/
  );
  assert.match(styles, /\.uc-generation-two-pane__controls \{[\s\S]*overflow-y: auto;/);
  assert.match(styles, /\.uc-generation-two-pane__result > \.uc-image-workbench__canvas \{[\s\S]*min-height: 100%;/);
  assert.match(styles, /\.uc-scrollbar::-webkit-scrollbar \{[\s\S]*width: 12px;/);
  assert.match(styles, /\.uc-scrollbar::-webkit-scrollbar-button \{[\s\S]*display: none;/);
  assert.match(styles, /\.uc-scrollbar::-webkit-scrollbar-thumb \{[\s\S]*border-radius: var\(--uc-radius-full\);/);
});

test('all generation workbenches fill the space above the project status bar', () => {
  assert.match(imageWorkbench, /isGenerationImage \? ' uc-image-workbench--generation' : ''/);
  assert.match(videoWorkbench, /usesFlowAutosave \? ' uc-image-workbench--generation' : ''/);
  assert.match(
    styles,
    /\.uc-image-workbench--generation \{[\s\S]*height: 100%;[\s\S]*grid-template-rows: auto minmax\(0, 1fr\);[\s\S]*padding-bottom: 0;/
  );
  assert.match(
    styles,
    /\.uc-image-workbench--generation > \.uc-generation-two-pane \{[\s\S]*height: 100%;/
  );
});

test('professional video pages keep prompts and submission controls out of the result area', () => {
  for (const { path, source } of sources.filter(({ path }) => path.includes('VideoText') || path.includes('VideoImage'))) {
    const controls = source.indexOf('uc-generation-two-pane__controls');
    const result = source.indexOf('uc-generation-two-pane__result');
    const preview = source.indexOf('<GenerationHistory');
    assert.ok(controls >= 0 && result > controls, `${path} should place result area after parameters`);
    assert.ok(preview > result, `${path} should render preview only in the result area`);
    assert.ok(source.indexOf('<VideoFeatureSubmissionPanel') < result, `${path} should keep submission controls left`);
  }
});

test('professional video preparation forms keep a single-column editing flow', () => {
  assert.match(
    styles,
    /\.uc-generation-two-pane__preparation-flow \{[\s\S]*grid-template-columns: minmax\(0, 1fr\);/
  );

  for (const { path, source } of sources.filter(({ path }) => path.includes('VideoText') || path.includes('VideoImage'))) {
    assert.match(
      source,
      /uc-generation-two-pane__preparation-flow/,
      `${path} should group preparation cards into one vertical editing flow`
    );
  }
});

test('professional video preparation is enclosed in one complete panel', () => {
  assert.match(
    styles,
    /\.uc-generation-two-pane__preparation \{[\s\S]*gap: 0;[\s\S]*border: 1px solid var\(--uc-color-border-default\);[\s\S]*border-radius: var\(--uc-radius-10\);/
  );
  assert.match(
    styles,
    /\.uc-generation-two-pane__preparation \{[\s\S]*grid-template-rows: auto minmax\(0, 1fr\) auto;/
  );
});

test('generation parameter panels share the reusable scrollbar style', () => {
  for (const { path, source } of sources) {
    assert.match(source, /uc-scrollbar/, `${path} should apply the shared scrollbar class`);
  }
  assert.match(appLayout, /workspace uc-scrollbar/);
});

test('quick image uses the compact reusable submission variant', () => {
  const quick = sources.find(({ path }) => path.includes('ImageQuickWorkspace'))?.source ?? '';
  assert.match(quick, /uc-image-feature-panel--compact/);
  assert.match(imageFeaturePanel, /className\?: string/);
  assert.match(styles, /\.uc-image-feature-panel--compact \.uc-model-select \.rs-picker-toggle/);
  assert.match(styles, /\.uc-image-quick__compact-card \.uc-image-quick__field > span/);
});

test('quick video uses the compact reusable submission variant', () => {
  const quickVideo = sources.find(({ path }) => path.includes('VideoQuickWorkspace'))?.source ?? '';
  assert.match(quickVideo, /uc-image-quick__compact-card/);
  assert.match(quickVideo, /className="uc-image-feature-panel--compact"/);
  assert.match(styles, /.uc-image-quick__workspace\.uc-generation-two-pane \.uc-image-quick__composer\.uc-image-quick__compact-card {[\s\S]*min-height: 240px;/);
});

test('quick generation output is one framed reusable panel', () => {
  const quickImage = sources.find(({ path }) => path.includes('ImageQuickWorkspace'))?.source ?? '';
  const quickVideo = sources.find(({ path }) => path.includes('VideoQuickWorkspace'))?.source ?? '';
  assert.match(outputPanel, /export function GenerationOutputPanel/);
  assert.match(componentStyles, /\.uc-generation-output-panel \{[\s\S]*border: 1px solid var\(--uc-color-border-default\);/);
  assert.match(componentStyles, /\.uc-generation-output-panel \{[\s\S]*border-radius: var\(--uc-radius-10\);/);
  assert.match(quickImage, /<GenerationOutputPanel[\s\S]*<GenerationResultPreview[\s\S]*uc-image-quick__result-actions/);
  assert.match(quickVideo, /<GenerationOutputPanel[\s\S]*<GenerationResultPreview[\s\S]*uc-image-quick__result-actions/);
  assert.match(styles, /\.uc-generation-output-panel > \.uc-image-quick__stage \{[\s\S]*grid-template-rows: minmax\(0, 1fr\) auto;/);
});

test('quick generation uses the remaining left pane height for model and submission', () => {
  assert.match(
    styles,
    /\.uc-image-quick__workspace\.uc-generation-two-pane \.uc-generation-two-pane__controls \{[\s\S]*grid-template-rows: minmax\(0, 1fr\) auto;/
  );
  assert.match(
    styles,
    /\.uc-image-quick__workspace\.uc-generation-two-pane \.uc-image-quick__composer \{[\s\S]*grid-template-rows: minmax\(0, 1fr\);/
  );
  assert.match(
    styles,
    /\.uc-image-quick__workspace\.uc-generation-two-pane \.uc-image-quick__composer \{[\s\S]*align-content: stretch;/
  );
  assert.match(
    styles,
    /\.uc-image-quick__workspace\.uc-generation-two-pane \.uc-image-quick__composer\.uc-image-quick__compact-card \.uc-image-quick__field \{[\s\S]*height: 100%;[\s\S]*grid-template-rows: minmax\(0, 1fr\);/
  );
  assert.match(
    styles,
    /\.uc-image-quick__workspace\.uc-generation-two-pane \.uc-image-quick__composer\.uc-image-quick__compact-card textarea \{[\s\S]*height: 100%;[\s\S]*resize: none;/
  );
  assert.match(
    styles,
    /\.uc-image-quick__workspace\.uc-generation-two-pane \.uc-image-quick__composer\.uc-image-quick__compact-card \{[\s\S]*grid-template-rows: minmax\(0, 1fr\);/
  );
});

test('generated media is centred and scales within the output canvas', () => {
  assert.match(
    styles,
    /\.uc-generation-output-panel \.uc-image-quick__result-item \{[\s\S]*height: 100%;[\s\S]*place-items: center;/
  );
  assert.match(
    styles,
    /\.uc-generation-output-panel \.uc-image-quick__stage \.uc-image-quick__result-item img,[\s\S]*width: 100%;[\s\S]*height: 100%;[\s\S]*object-fit: contain;/
  );
});
