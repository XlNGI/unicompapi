import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile('src/pages/tasks/TasksPage.tsx', 'utf8');

test('task center consumes controlled global task read models', () => {
  assert.match(source, /storage\.listTasks\(\)/);
  assert.match(source, /storage\.getTaskDetails\(selectedTaskId\)/);
  assert.doesNotMatch(source, /rootDirectory|absolutePath|readFile|writeFile/);
});

test('task center covers the real execution and recovery states', () => {
  for (const state of [
    'queued',
    'processing',
    'remote_completed',
    'downloading',
    'verifying',
    'completed',
    'failed',
    'cancellation_unknown'
  ]) assert.match(source, new RegExp(`${state}:`));
  assert.match(source, /可重试/);
  assert.match(source, /不可恢复/);
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

test('task center does not invent execution metrics or write operations', () => {
  assert.doesNotMatch(source, /百分比|排队时间|费用|预计剩余|retryTask|cancelTask/);
});
