import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = await readFile('src/pages/tasks/TasksPage.tsx', 'utf8');
const calls = await readFile('src/pages/tasks/CallRecordsView.tsx', 'utf8');
const taskCenterWorkspace = await readFile(
  'src/pages/tasks/TaskCenterWorkspace.tsx',
  'utf8'
);
const floatingStatusBar = await readFile(
  'src/components/FloatingStatusBar.tsx',
  'utf8'
);
const styles = await readFile('src/styles/pages.css', 'utf8');
const shellStyles = await readFile('src/styles.css', 'utf8');
const failureReasons = await readFile(
  'src/ui/notifications/generation-failure-reasons.ts',
  'utf8'
);

test('task center keeps tasks and call records as explicit segmented views', () => {
  assert.match(page, /role="tablist"/);
  assert.match(page, /aria-selected=\{view === 'tasks'\}/);
  assert.match(page, /aria-selected=\{view === 'calls'\}/);
  assert.match(page, /role="tabpanel"/);
  assert.match(calls, /role="tabpanel"/);
  assert.match(page, />\s*任务\s*</);
  assert.match(page, />\s*调用记录\s*</);
  assert.match(page, /CallRecordsView/);
});

test('tasks and calls share one independently scrolling workspace component', () => {
  assert.match(shellStyles, /\.workspace--tasks\s*\{[\s\S]*overflow: hidden;/);
  assert.match(styles, /\.uc-task-center\s*\{[\s\S]*height: 100%;/);
  assert.match(page, /<TaskCenterWorkspace/);
  assert.match(calls, /<TaskCenterWorkspace/);
  assert.match(taskCenterWorkspace, /uc-task-center__list uc-scrollbar/);
  assert.match(taskCenterWorkspace, /uc-task-center__details uc-scrollbar/);
  assert.match(
    styles,
    /\.uc-task-center__list,\s*\.uc-task-center__details\s*\{[^}]*overflow-y: auto;[^}]*overscroll-behavior: contain;/
  );
  assert.doesNotMatch(calls, /uc-task-center__details--scrollable/);
});

test('call records use the controlled list and detail read ports', () => {
  assert.match(calls, /storage\.listCallRecords\(toRequest\(filters\)\)/);
  assert.match(calls, /storage\.getCallDetails\(selectedCallId\)/);
  for (const filter of [
    'projectId',
    'productFeature',
    'providerId',
    'connectionId',
    'modelId',
    'state',
    'createdFrom',
    'createdTo'
  ]) assert.match(calls, new RegExp(filter));
  assert.match(calls, /DateRangePicker/);
  assert.match(calls, /character=" 至 "/);
  assert.match(calls, /parseDateRange\(filters\.createdFrom, filters\.createdTo\)/);
  assert.match(calls, /开始日期不能晚于结束日期/);
});

test('call-record filters stay in one compact row', () => {
  assert.match(
    styles,
    /\.uc-task-center__call-filters\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1\.15fr\)\s*minmax\(0, 1\.05fr\)\s*repeat\(3, minmax\(0, 0\.8fr\)\)\s*minmax\(0, 0\.95fr\)\s*minmax\(160px, 1\.7fr\);/
  );
  assert.match(
    styles,
    /\.uc-task-center__call-filters\s*\{[^}]*gap: 10px;[^}]*padding: var\(--uc-space-4\);/
  );
  assert.doesNotMatch(styles, /\.uc-task-center__call-filters\s*\{[^}]*overflow-x:/);
  assert.match(
    styles,
    /\.uc-task-center__call-filters \.rs-picker-toggle\s*\{[^}]*min-height: 40px;/
  );
  assert.doesNotMatch(
    styles,
    /\.uc-task-center__call-filters\s*\{[^}]*repeat\(auto-fit/
  );
});

test('call-record read issues use the shared floating status bar', () => {
  assert.match(calls, /FloatingStatusBar/);
  assert.match(calls, /<FloatingStatusBar label="状态" tone="warning">/);
  assert.match(calls, /部分项目的调用记录无法读取/);
  assert.doesNotMatch(calls, /uc-task-center__issues/);
  assert.match(floatingStatusBar, /export function FloatingStatusBar/);
});

test('call details show snapshot names, timeline, duration, retry, usage and local results', () => {
  for (const fact of [
    'providerName',
    'connectionName',
    'modelName',
    'durationMs',
    'retryOfInvocationAttemptId',
    'timeline',
    'usage.availability',
    'usage.facts',
    'localResults',
    'resultRegistration'
  ]) assert.match(calls, new RegExp(fact.replace('.', '\\.')));
  assert.match(calls, /服务商未返回用量/);
  assert.match(calls, /调用结果未知，用量无法确认/);
  assert.match(calls, /本地校验通过/);
  assert.match(calls, /已登记作品/);
});

test('call records remain read-only and omit protected provider and content facts', () => {
  assert.doesNotMatch(
    calls,
    /originalInput|finalPrompt|promptSnapshot|outboundText|absolutePath|contentHash|routeSnapshot|packageId|adapterKey|protocolId|endpointUrl|endpointTemplate|endpointPolicy|credential|authorization|remoteOperation|signedUrl|rawResponse|stackTrace/i
  );
  assert.doesNotMatch(calls, /fetch\(|writeFile|createTask|retryTask|cancelTask|localStorage/);
});

test('registered call results use bounded local previews and never render provider image links', () => {
  assert.match(calls, /storage\.getWorkDetails\(workId\)/);
  assert.match(calls, /storage\.createWorkMediaHandle\(workId\)/);
  assert.match(calls, /storage\.revealWorkFile\(workId\)/);
  assert.match(calls, />\s*打开文件位置\s*</);
  assert.match(calls, /已保存到当前项目/);
  assert.doesNotMatch(calls, /resultImageUrl|图片链接/);
  assert.match(styles, /\.uc-task-center__result-preview[\s\S]*?height: 220px/);
  assert.match(styles, /\.uc-task-center__result-preview img,[\s\S]*?object-fit: contain/);
  assert.match(styles, /\.uc-task-center__result-list \.uc-task-center__result-card[\s\S]*?overflow: hidden/);
});

test('call timeline shows theme-aware safe failure reasons instead of a hidden placeholder', () => {
  assert.match(calls, /describeGenerationSafeCode\(event\.safeCode\)/);
  assert.match(calls, /未记录可公开的具体失败原因/);
  assert.match(calls, /技术代码：\{reason\.technicalCode\}/);
  assert.doesNotMatch(calls, /详细原因已记录/);
  assert.match(failureReasons, /authentication_failed: '服务商鉴权失败'/);
  assert.match(failureReasons, /label: '未识别的服务商错误'/);
  assert.match(styles, /\.uc-task-center__timeline-reason--danger \{[\s\S]*?var\(--uc-color-status-danger-bg\)/);
  assert.match(styles, /\.uc-task-center__timeline-reason--warning \{[\s\S]*?var\(--uc-color-status-warning-bg\)/);
});

test('call records distinguish submission and generation lifecycle states', () => {
  assert.match(calls, /failed_before_submission: \{ label: '提交失败'/);
  assert.match(calls, /accepted: \{ label: '提交成功'/);
  assert.match(calls, /running: \{ label: '生成中'/);
  assert.match(calls, /failed: \{ label: '生成失败'/);
});
