import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const history = await readFile('src/components/GenerationHistory.tsx', 'utf8');
const preview = await readFile('src/components/VideoPreview.tsx', 'utf8');
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
    assert.match(source, /userTookOverRef={userTookOverRef}/);
    assert.match(source, /const userTookOverRef = useRef\(false\)/);
    assert.match(source, /if \(phase === 'preparing'\) userTookOverRef\.current = false;/);
    assert.doesNotMatch(source, /onUserSelection/);
  }
});

test('workspace owns the takeover state and shared history keeps no duplicate copy', () => {
  assert.match(history, /readonly userTookOverRef: MutableRefObject<boolean>;/);
  assert.match(history, /if \(isPendingGeneration && !userTookOverRef\.current\)/);
  assert.match(history, /hasPendingGeneration: hasPendingGeneration && !userTookOverRef\.current/);
  assert.match(history, /userTookOverRef\.current = true;/);
  assert.doesNotMatch(history, /userSelectedRef/);
  assert.doesNotMatch(history, /onUserSelection/);
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
  assert.match(history, /preload="metadata"/);
  assert.match(history, /loading="lazy"/);
  assert.match(history, /decoding="async"/);
  assert.match(history, /IntersectionObserver/);
  assert.match(history, /resolveHistorySelection\(/);
  assert.match(history, /handleWorkSelection\(node\.work\.workId\)/);
  assert.match(styles, /\.uc-generation-history\s*{[\s\S]*width: 100%;[\s\S]*height: 100%;/);
  assert.match(
    styles,
    /\.uc-generation-history__preview > \.uc-image-quick__result-list\s*{[\s\S]*grid-template-rows: minmax\(0, 1fr\);/
  );
  assert.match(
    styles,
    /\.uc-generation-history__preview \.uc-generation-result-preview\s*{[\s\S]*grid-template-rows: minmax\(0, 1fr\);/
  );
  assert.match(styles, /\.uc-generation-history__work video/);
  assert.match(preview, /setExpanded\(\(value\) => !value\)/);
  assert.match(preview, /controlsList="nofullscreen"/);
  assert.match(preview, /event\.key === 'Escape'/);
  assert.match(preview, /uc-video-preview--expanded/);
  assert.match(styles, /\.uc-video-preview--expanded\s*{[\s\S]*position: fixed;[\s\S]*z-index: 1000;[\s\S]*inset: 0;/);
  assert.match(styles, /\.uc-generation-history__preview \.uc-generation-result-preview video/);
  assert.match(
    styles,
    /\.uc-generation-history__preview \.uc-generation-result-preview img,[\s\S]*\.uc-generation-history__preview \.uc-generation-result-preview video\s*{[\s\S]*width: 100%;[\s\S]*height: 100%;[\s\S]*object-fit: contain;/
  );
  // 拖拽仅对图片开放，视频结果不可拖拽
  assert.match(history, /draggable=\{Boolean\(selectedWorkId && mediaKind === 'image'\)\}/);
});

test('shared history video fills the preview pane instead of shrinking to its intrinsic size', () => {
  const rule = styles.match(
    /\.uc-generation-history__preview \.uc-video-preview video\s*\{([\s\S]*?)\}/
  );
  assert.ok(rule, 'history preview must size the video element mounted by .uc-video-preview');
  const body = rule[1];
  assert.match(body, /width: 100%;/);
  assert.match(body, /height: 100%;/);
  assert.match(body, /max-height: 100%;/);
  assert.doesNotMatch(body, /width: auto;/);
  assert.doesNotMatch(body, /height: auto;/);
});

test('image-to-video preview isolates native controls from the two-pane inline-size cycle', () => {
  const host = styles.match(
    /\.uc-video-image__workspace \.uc-generation-history__preview \.uc-video-preview\s*\{([\s\S]*?)\}/
  );
  assert.ok(host, 'image-to-video preview host must isolate inline size');
  assert.match(host[1], /contain: inline-size;/);
  assert.match(host[1], /min-width: 0;/);

  const video = styles.match(
    /\.uc-video-image__workspace \.uc-generation-history__preview \.uc-video-preview video\s*\{([\s\S]*?)\}/
  );
  assert.ok(video, 'image-to-video preview video must leave the size cycle');
  assert.match(video[1], /position: absolute;/);
  assert.match(video[1], /inset: 0;/);
  assert.match(video[1], /width: 100%;/);
  assert.match(video[1], /height: 100%;/);
  assert.doesNotMatch(
    styles,
    /\.uc-video-text__workspace \.uc-generation-history__preview \.uc-video-preview video\s*\{/
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
