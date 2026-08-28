import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile('src/pages/tasks/TasksPage.tsx', 'utf8');
const feeSource = await readFile('src/pages/tasks/call-fees.ts', 'utf8');
const appSource = await readFile('src/ui/App.tsx', 'utf8');

test('task center consumes controlled global task read models', () => {
  assert.match(source, /storage\.listTasks\(\)/);
  assert.match(source, /storage\.getTaskDetails\(selectedTaskId\)/);
  assert.doesNotMatch(source, /rootDirectory|absolutePath|readFile|writeFile/);
});

test('task center covers the real execution and recovery states', () => {
  for (const state of [
    'queued',
    'processing',
    'submission_outcome_unknown',
    'remote_completed',
    'downloading',
    'verifying',
    'completed',
    'failed',
    'cancellation_unknown'
  ]) assert.match(source, new RegExp(`${state}:`));
  assert.match(source, /可重试/);
  assert.match(source, /不可恢复/);
  assert.match(source, /submission_outcome_unknown: \{ label: '提交结果未知'/);
  assert.match(source, /label: '未知任务状态'/);
  assert.doesNotMatch(source, /\{ label: state, tone:/);
});

test('task center provides filters, details, source navigation, and honest issues', () => {
  assert.match(source, /type="search"/);
  assert.match(source, /全部项目/);
  assert.match(source, /全部状态/);
  assert.match(source, /originalInput/);
  assert.match(source, /finalPrompt/);
  assert.match(source, /image_generation: '图片生成'/);
  assert.match(source, /返回来源项目/);
  assert.match(source, /查看已登记作品/);
  assert.match(source, /任务数据损坏/);
});

test('task center folds task and provider call facts into one timeline', () => {
  assert.match(source, /TaskUnifiedTimeline/);
  assert.match(source, /storage\.listCallRecords\(\{ projectId: details\.projectId, limit: 200 \}\)/);
  assert.match(source, /storage\.getCallDetails\(record\.invocationAttemptId\)/);
  assert.match(source, /call\?\.subject\.kind === 'media' && call\.subject\.taskId === details\.taskId/);
  assert.match(source, /<TimelineItem[\s\S]*title="创建任务"/);
  assert.match(source, /<TimelineItem[\s\S]*title="确认输入"/);
  assert.match(source, /calls\.flatMap\(\(call\) => callTimelineItems\(call\)\)/);
  assert.match(source, /uc-task-center__unified-timeline/);
  assert.match(source, /uc-task-center__timeline-prompts/);
  assert.doesNotMatch(source, /任务中心视图|call-records-tab|task-records-tab/);
  assert.doesNotMatch(source, /调用尝试|调用详情|variant="embedded"|uc-task-center__embedded-calls/);
});

test('task center shows successful-call fee charts from official pricing rules', () => {
  assert.match(source, /TaskConsumptionCharts/);
  assert.match(source, /EmptyBarChart/);
  assert.match(source, /EmptyDonutChart/);
  assert.match(source, /消费柱状图/);
  assert.match(source, /供应商消费占比/);
  assert.match(source, /storage\.getConsumptionSummary\(\)/);
  assert.match(source, /storage\?\.onLocalStorageChanged/);
  assert.doesNotMatch(source, /storage\.listCallRecords\(\{ limit: 200 \}\)/);
  assert.match(source, /formatRenminbiAmount/);
  assert.match(source, /pendingConversionCallCount/);
  assert.match(source, /非人民币费用待换算，未混入人民币总额/);
  assert.match(source, /前 5 个供应商外归入“其他”/);
  assert.match(source, /donutGradient\(providerSlices\)/);
  assert.match(source, /暂无可计算费用的消费柱状图/);
  assert.match(source, /暂无可计算费用的供应商消费占比环形图/);
  assert.match(source, /missingPricingRuleCount/);
  assert.match(source, /missingUsageCount/);
  assert.match(source, /缺官方价格规则/);
  assert.match(source, /缺响应体计费用量/);
  assert.match(source, /不等于服务商正式账单/);
  assert.match(feeSource, /call\.officialPricingRule/);
  assert.match(feeSource, /provider_billing/);
  assert.match(feeSource, /token_split/);
  assert.match(feeSource, /image_count/);
  assert.match(feeSource, /video_second/);
  assert.match(feeSource, /缺少官方价格规则/);
  assert.match(feeSource, /缺少计费用量/);
  assert.doesNotMatch(feeSource, /official_total_price|explicitUnitPrice/);
  assert.doesNotMatch(feeSource, /providerId|modelId|viduq3|seedance|doubao|kling|newapi/i);
});

test('task center does not invent execution metrics or write operations', () => {
  assert.doesNotMatch(source, /百分比|排队时间|预计剩余|retryTask|cancelTask/);
});

test('task center recovers only an existing remote video result without resubmission', () => {
  assert.match(source, /details\.canRecoverVideoResult/);
  assert.match(source, /window\.unicomp\?\.videoFeatures/);
  assert.match(source, /features\.recoverResult\(taskId\)/);
  assert.match(source, /重新接收结果/);
  assert.doesNotMatch(source, /recoverResult[\s\S]*submitDraft\(/);
});

test('task center recovers an existing image result without resubmission', () => {
  assert.match(source, /details\.canRecoverImageResult/);
  assert.match(source, /window\.unicomp\?\.imageFeatures/);
  assert.match(source, /features\.recoverResult\(taskId\)/);
  assert.doesNotMatch(source, /recoverResult[\s\S]*submitDraft\(/);
});

test('task center reuses the original draft parameters within the same project', () => {
  assert.match(source, /复用参数/);
  assert.match(source, /onReuseParameters/);
  assert.match(source, /不可跨项目复制参数/);
  assert.match(source, /window\.unicomp\?\.imageWorkspaces\?\.list\(\)/);
  assert.match(source, /window\.unicomp\?\.videoWorkspaces\?\.list\(\)/);
  assert.match(appSource, /onReuseParameters=\{handleReuseParameters\}/);
  assert.match(appSource, /preferredDraftId=\{openedImageDraftId\}/);
  assert.match(appSource, /preferredDraftId=\{openedVideoDraftId\}/);
});
