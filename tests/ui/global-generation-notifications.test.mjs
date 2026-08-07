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
const failureReasons = await readFile(
  'src/ui/notifications/generation-failure-reasons.ts',
  'utf8'
);
const progressSteps = await readFile(
  'src/components/SubmissionProgressSteps.tsx',
  'utf8'
);

test('mounts one app-level notification provider so notices survive page navigation', () => {
  assert.match(main, /<GlobalNotificationProvider>[\s\S]*?<App \/>[\s\S]*?<\/GlobalNotificationProvider>/);
  assert.match(provider, /createContext/);
  assert.match(provider, /current\.map\(\(item\) => item\.id === notification\.id \? next : item\)/);
});

test('keeps failures at the top right until the user closes them', () => {
  assert.match(provider, /placement="top-end"/);
  assert.match(provider, /closable=\{item\.kind === 'error' \|\| item\.kind === 'warning'\}/);
  assert.match(provider, /role=\{item\.kind === 'error' \|\| item\.kind === 'warning' \? 'alert' : 'status'\}/);
  assert.match(styles, /\.uc-global-notifications--top-end \{[\s\S]*?top: calc\(42px \+ var\(--uc-space-4\)\);[\s\S]*?right: var\(--uc-space-4\)/);
});

test('generation failures show only a safe failure reason', () => {
  assert.match(provider, /findTrackedFailureSafeCode/);
  assert.match(provider, /storage\.listCallRecords/);
  assert.match(provider, /storage\.getCallDetails/);
  assert.match(provider, /describeGenerationSafeCode/);
  assert.match(provider, /generationFailureReason/);
  assert.match(provider, /: `\$\{mediaLabel\}生成失败`/);
  assert.match(provider, /item\.action && !isGenerationFailure\(item\)/);
  assert.doesNotMatch(provider, /任务中心确认生成失败，请打开任务详情查看安全失败原因/);
  assert.match(failureReasons, /submission_outcome_unknown: '服务商是否收到请求暂时无法确认'/);
});

test('distinguishes confirmed provider failures from unconfirmed outcomes', () => {
  for (const panel of [imagePanel, videoPanel]) {
    assert.match(panel, /isUnconfirmedGenerationOutcome/);
    assert.match(panel, /describeUnconfirmedGenerationOutcome/);
    assert.match(panel, /kind: 'warning'/);
    assert.match(panel, /生成状态待确认/);
    assert.match(panel, /setProgressPhase\('uncertain'\)/);
  }
  assert.match(provider, /isUnconfirmedGenerationOutcome/);
  assert.match(provider, /describeUnconfirmedGenerationOutcome/);
  assert.match(failureReasons, /等待上游响应超时，暂未收到可确认结果/);
  assert.match(failureReasons, /与上游的连接已中断，暂未收到可确认结果/);
  assert.match(progressSteps, /\| 'uncertain'/);
  assert.match(progressSteps, /状态待确认/);
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

test('allows compact success notices with only the component icon and title', () => {
  assert.match(provider, /item\.description \? <p>/);
  assert.match(provider, /uc-global-notifications__item--compact/);
  assert.match(styles, /\.uc-global-notifications__item--compact \.rs-notification/);
});

test('uses the shared compact floating notification dimensions', () => {
  assert.match(styles, /--uc-floating-notice-width: 360px;/);
  assert.match(styles, /--uc-floating-notice-min-height: 52px;/);
  assert.match(styles, /--uc-floating-notice-padding: 10px 12px;/);
  assert.match(styles, /width: min\(var\(--uc-floating-notice-width\), calc\(100vw - var\(--uc-space-6\)\)\);/);
  assert.match(styles, /min-height: var\(--uc-floating-notice-min-height\);/);
  assert.match(styles, /--rs-notify-spacing: 10px;/);
  assert.match(styles, /--rs-notify-title-description-gap: 3px;/);
  assert.match(styles, /border-left-width: 3px;/);
});

test('uses structured notifications for real image and video submission boundaries', () => {
  for (const panel of [imagePanel, videoPanel]) {
    assert.match(panel, /useGlobalNotifications/);
    assert.match(panel, /正在保存当前草稿并准备安全提交信息/);
    assert.match(panel, /正在向主进程准备安全提交信息/);
    assert.match(panel, /正在向主进程提交生成请求/);
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

test('separates submission and generation lifecycle feedback', () => {
  assert.match(imagePanel, /title: '图片提交失败'/);
  assert.match(videoPanel, /title: '视频提交失败'/);
  assert.match(imagePanel, /'图片提交中'/);
  assert.match(videoPanel, /'视频提交中'/);
  assert.match(imagePanel, /'图片生成中'/);
  assert.match(videoPanel, /'视频生成中'/);
  assert.match(imagePanel, /submission\.status === 'failed_before_submission'/);
  assert.match(videoPanel, /submission\.status === 'failed_before_submission'/);
  assert.doesNotMatch(imagePanel, /promoteWaiting/);
  assert.doesNotMatch(videoPanel, /promoteWaiting/);
  assert.match(provider, /state === 'submitting'[\s\S]*?`\$\{mediaLabel\}提交中`/);
  assert.match(provider, /failure\?\.state === 'failed_before_submission'/);
  assert.match(provider, /`\$\{mediaLabel\}提交失败`/);
  assert.match(provider, /`\$\{mediaLabel\}生成失败`/);
  assert.match(progressSteps, /label: '提交中'/);
  assert.match(progressSteps, /label: '生成中'/);
  assert.match(progressSteps, /'提交成功'/);
  assert.match(progressSteps, /'提交失败'/);
  assert.match(progressSteps, /'生成失败'/);
  assert.match(progressSteps, /\| 'submission_failed'/);
  assert.match(progressSteps, /\| 'submission_uncertain'/);
  assert.match(imagePanel, /'submission_failed'/);
  assert.match(videoPanel, /'submission_failed'/);
});

test('keeps ordinary workbench feedback separate from generated-state notifications', () => {
  assert.match(imageWorkbench, /uc-image-workbench__message-card/);
  assert.match(videoWorkbench, /uc-image-workbench__message/);
  assert.doesNotMatch(imageWorkbench, /正在生成…/);
  assert.doesNotMatch(videoWorkbench, /正在生成…/);
});
