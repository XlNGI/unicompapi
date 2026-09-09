import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const history = await readFile('src/components/GenerationHistory.tsx', 'utf8');
const styles = await readFile('src/styles/pages.css', 'utf8');
const consumers = await Promise.all([
  ['src/pages/creation/image/ImageProfessionalWorkspace.tsx', 'image'],
  ['src/pages/creation/video/VideoTextWorkspace.tsx', 'video'],
  ['src/pages/creation/video/VideoImageWorkspace.tsx', 'video']
].map(async ([path, mediaKind]) => ({
  mediaKind,
  path,
  source: await readFile(path, 'utf8')
})));

test('professional image and video workspaces share one generation history component', () => {
  assert.match(history, /export function GenerationHistory/);
  for (const { mediaKind, path, source } of consumers) {
    assert.match(source, /import { GenerationHistory }/, `${path} should import shared history`);
    assert.match(source, /<GenerationHistory/, `${path} should render shared history`);
    assert.match(source, new RegExp(`mediaKind="${mediaKind}"`));
    assert.match(source, /draftId={draft\.draftId}/);
    assert.match(source, /projectId={draft\.projectId}/);
    assert.match(source, /refreshKey={historyRefreshKey}/);
    assert.match(source, /submissionProgress={submissionProgress}/);
  }
});

test('shared history accepts only current-draft verified local media works', () => {
  assert.match(history, /storage\.listGenerationHistory\(\{/);
  assert.match(history, /projectId,/);
  assert.match(history, /draftId,/);
  assert.match(history, /mediaKind,/);
  assert.match(history, /limit: 20/);
  assert.doesNotMatch(history, /storage\.listTasks|storage\.listWorks|storage\.getTaskDetails|storage\.getWorkDetails/);
  assert.doesNotMatch(history, /remoteUrls|fetch\(|localStorage/);
});

test('shared history supports image and video previews with stable selection', () => {
  assert.match(history, /mediaKind === 'image'/);
  assert.match(history, /<img/);
  assert.match(history, /<video/);
  assert.match(history, /preload="none"/);
  assert.match(history, /loading="lazy"/);
  assert.match(history, /decoding="async"/);
  assert.match(history, /IntersectionObserver/);
  assert.match(history, /setSelectedWorkId\(history\.works\[history\.works\.length - 1\]\?\.workId\)/);
  assert.match(history, /setSelectedWorkId\(node\.work\.workId\)/);
  assert.match(styles, /\.uc-generation-history\s*{[\s\S]*width: 100%;[\s\S]*height: 100%;/);
  assert.match(
    styles,
    /\.uc-generation-history__preview > \.uc-image-quick__result-list\s*{[\s\S]*grid-template-rows: minmax\(0, 1fr\);/
  );
  assert.match(
    styles,
    /\.uc-generation-history__preview \.uc-generation-result-preview\s*{[\s\S]*grid-template-rows: minmax\(0, 1fr\);/
  );
  assert.match(styles, /\.uc-generation-history__preview \.uc-generation-result-preview video/);
  assert.match(styles, /\.uc-generation-history__work video/);
  assert.match(
    styles,
    /\.uc-generation-history__preview \.uc-generation-result-preview img,[\s\S]*\.uc-generation-history__preview \.uc-generation-result-preview video\s*{[\s\S]*width: 100%;[\s\S]*height: 100%;[\s\S]*object-fit: contain;/
  );
});

test('shared history maps wheel gestures to horizontal overflow without trapping boundaries', () => {
  assert.match(history, /onWheel={handleTimelineWheel}/);
  assert.match(history, /event\.deltaX/);
  assert.match(history, /event\.deltaY/);
  assert.match(history, /timeline\.scrollWidth <= timeline\.clientWidth/);
  assert.match(history, /nextScrollLeft === timeline\.scrollLeft/);
  assert.match(history, /event\.preventDefault\(\)/);
  assert.match(styles, /\.uc-generation-history__timeline-scroll\s*{[\s\S]*overflow-x: auto;/);
});
