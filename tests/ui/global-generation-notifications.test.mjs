import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const main = await readFile('src/main.tsx', 'utf8');
const provider = await readFile(
  'src/ui/notifications/GlobalNotificationProvider.tsx',
  'utf8'
);
const imagePanel = await readFile(
  'src/pages/creation/image/ImageFeatureSubmissionPanel.tsx',
  'utf8'
);
const videoPanel = await readFile(
  'src/pages/creation/video/VideoFeatureSubmissionPanel.tsx',
  'utf8'
);
const imageWorkbench = await readFile(
  'src/pages/creation/image/ImageWorkbenchPage.tsx',
  'utf8'
);
const videoWorkbench = await readFile(
  'src/pages/creation/video/VideoWorkbenchPage.tsx',
  'utf8'
);
const styles = await readFile('src/styles.css', 'utf8');
const progressSteps = await readFile(
  'src/components/SubmissionProgressSteps.tsx',
  'utf8'
);

test('keeps the app-level provider for ordinary non-generation notices', () => {
  assert.match(main, /<GlobalNotificationProvider>[\s\S]*?<App \/>[\s\S]*?<\/GlobalNotificationProvider>/);
  assert.match(provider, /createContext/);
  assert.match(provider, /current\.map\(\(item\) => item\.id === notification\.id \? notification : item\)/);
  assert.match(provider, /notification\.kind === 'success'/);
  assert.match(provider, /window\.setTimeout/);
});

test('rejects every image and video generation notice before it enters state', () => {
  assert.match(provider, /if \(isGenerationNotice\(notification\)\) return;/);
  assert.match(provider, /\^\(\?:image\|video\)-generation:/);
  assert.doesNotMatch(provider, /tracking\?:/);
  assert.doesNotMatch(provider, /storage\.listTasks\(\)/);
  assert.doesNotMatch(provider, /findTrackedTask|findTrackedFailureSafeCode/);
  assert.doesNotMatch(provider, /isSilentGenerationNotice/);
});

test('removes the generation notification component from image and video submission panels', () => {
  for (const panel of [imagePanel, videoPanel]) {
    assert.doesNotMatch(panel, /useGlobalNotifications/);
    assert.doesNotMatch(panel, /notifications\.(?:show|dismiss)/);
    assert.doesNotMatch(panel, /(?:image|video)-generation:/);
    assert.doesNotMatch(panel, /title: '(?:图片|视频)(?:提交|生成)/);
    assert.doesNotMatch(panel, /title: '已成功生成'/);
    assert.doesNotMatch(panel, /tracking:/);
  }
});

test('keeps lifecycle state in the page and task surfaces', () => {
  for (const panel of [imagePanel, videoPanel]) {
    assert.match(panel, /onProgressChange\?\.\(progressPhase, progressFailure\)/);
    assert.match(panel, /setProgressPhase\('requesting'\)/);
    assert.match(panel, /setProgressPhase\('waiting'\)/);
    assert.match(panel, /setProgressPhase\('completed'\)/);
    assert.match(panel, /setProgressFailure/);
    assert.match(panel, /onMessage\(description\)/);
  }
  assert.match(progressSteps, /\| 'uncertain'/);
  assert.match(progressSteps, /状态待确认/);
});

test('keeps ordinary floating notices functional and dismissible', () => {
  assert.match(provider, /placement="top-end"/);
  assert.match(provider, /placement="bottom-start"/);
  assert.match(provider, /closable=\{item\.kind === 'error' \|\| item\.kind === 'warning'\}/);
  assert.match(provider, /role=\{item\.kind === 'error' \|\| item\.kind === 'warning' \? 'alert' : 'status'\}/);
  assert.match(provider, /item\.description \? <p>\{item\.description\}<\/p>/);
  assert.match(provider, /item\.action \? \(/);
});

test('keeps the shared compact floating notification styling for other features', () => {
  assert.match(styles, /--uc-floating-notice-width: 360px;/);
  assert.match(styles, /--uc-floating-notice-min-height: 52px;/);
  assert.match(styles, /--uc-floating-notice-padding: 10px 12px;/);
  assert.match(styles, /\.uc-global-notifications--top-end \{[\s\S]*?right: var\(--uc-space-4\)/);
  assert.match(styles, /\.uc-global-notifications--bottom-start \{[\s\S]*?bottom:[\s\S]*?left:/);
});

test('keeps workbench feedback separate from generated-state notifications', () => {
  assert.match(imageWorkbench, /<FloatingStatusBar>/);
  assert.match(videoWorkbench, /<FloatingStatusBar>/);
  assert.match(imageWorkbench, /uc-image-workbench__message/);
  assert.match(videoWorkbench, /uc-image-workbench__message/);
  assert.doesNotMatch(imageWorkbench, /uc-image-workbench__message-card/);
  assert.doesNotMatch(videoWorkbench, /uc-image-workbench__message-card/);
});
