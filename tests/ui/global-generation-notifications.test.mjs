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

test('mounts one app-level notification provider so notices survive page navigation', () => {
  assert.match(main, /<GlobalNotificationProvider>[\s\S]*?<App \/>[\s\S]*?<\/GlobalNotificationProvider>/);
  assert.match(provider, /createContext/);
  assert.match(provider, /current\.map\(\(item\) => item\.id === notification\.id \? next : item\)/);
});

test('keeps failures at the top right until the user closes them', () => {
  assert.match(provider, /placement="top-end"/);
  assert.match(provider, /closable=\{item\.kind === 'error' \|\| item\.kind === 'warning'\}/);
  assert.match(provider, /role=\{item\.kind === 'error' \|\| item\.kind === 'warning' \? 'alert' : 'status'\}/);
  assert.match(styles, /\.uc-global-notifications--top-end \{[\s\S]*?top: calc\(42px \+ var\(--uc-space-4\)\);[\s\S]*?right: var\(--uc-space-6\)/);
});

test('shows successful generation at the bottom left and removes it automatically', () => {
  assert.match(provider, /const successDurationMs = 5_000/);
  assert.match(provider, /notification\.kind === 'success'/);
  assert.match(provider, /window\.setTimeout/);
  assert.match(provider, /placement="bottom-start"/);
  assert.match(provider, /uc-global-notifications__progress--\$\{item\.kind\}/);
  assert.match(provider, /animationDuration: `\$\{successDurationMs\}ms`/);
  assert.match(styles, /\.uc-global-notifications--bottom-start \{[\s\S]*?bottom:[\s\S]*?left:/);
  assert.match(styles, /@keyframes uc-global-notification-countdown/);
});

test('uses structured notifications for real image and video submission boundaries', () => {
  for (const panel of [imagePanel, videoPanel]) {
    assert.match(panel, /useGlobalNotifications/);
    assert.match(panel, /正在保存当前草稿并准备安全提交信息/);
    assert.match(panel, /正在向主进程准备安全提交信息/);
    assert.match(panel, /正在向主进程提交生成请求并等待真实结果/);
    assert.match(panel, /kind: 'error'/);
    assert.match(panel, /kind: 'success'/);
    assert.match(panel, /title: '已成功生成'/);
    assert.match(panel, /status === 'provider_accepted'/);
    assert.match(panel, /tracking:/);
    assert.doesNotMatch(panel, /onMessage\('正在生成…'\)/);
  }
  assert.match(provider, /storage\.listTasks\(\)/);
  assert.match(provider, /storage\.getTaskDetails\(task\.taskId\)/);
  assert.match(provider, /taskProgressDescription/);
  assert.match(styles, /@keyframes uc-global-notification-flow/);
  assert.match(styles, /animation: uc-global-notification-flow 1\.4s ease-in-out infinite/);
  assert.doesNotMatch(provider, /percent|percentage|进度：\d/);
});

test('keeps ordinary workbench feedback separate from generated-state notifications', () => {
  assert.match(imageWorkbench, /uc-image-workbench__message-card/);
  assert.match(videoWorkbench, /uc-image-workbench__message/);
  assert.doesNotMatch(imageWorkbench, /正在生成…/);
  assert.doesNotMatch(videoWorkbench, /正在生成…/);
});
