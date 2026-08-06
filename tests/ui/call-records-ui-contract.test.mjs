import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = await readFile('src/pages/tasks/TasksPage.tsx', 'utf8');
const calls = await readFile('src/pages/tasks/CallRecordsView.tsx', 'utf8');

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
  assert.match(calls, /DatePicker/);
  assert.match(calls, /开始日期不能晚于结束日期/);
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
