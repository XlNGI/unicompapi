import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile('src/pages/library/LibraryPage.tsx', 'utf8');

test('work library consumes only controlled work and file operations', () => {
  for (const call of [
    'storage.listWorks()',
    'storage.getWorkDetails(selectedWorkId)',
    'storage.createWorkMediaHandle(selectedWorkId)',
    'storage.revealWorkFile(details.workId)',
    'storage.relinkFile(details.fileId)'
  ]) assert.match(source, new RegExp(call.replace(/[().]/g, '\\$&')));
  assert.doesNotMatch(source, /rootDirectory|absolutePath|readFile|writeFile|showOpenDialog/);
});

test('work library keeps abnormal records and provides honest recovery', () => {
  for (const state of ['missing', 'read_only', 'disconnected', 'corrupted']) {
    assert.match(source, new RegExp(`${state}:`));
  }
  assert.match(source, /重新定位文件/);
  assert.match(source, /项目失效或存储断开/);
  assert.match(source, /作品数据损坏/);
});

test('work library exposes filters, provenance, version and controlled preview', () => {
  assert.match(source, /type="search"/);
  assert.match(source, /全部项目/);
  assert.match(source, /全部类型/);
  assert.match(source, /全部状态/);
  assert.match(source, /sourceTaskId/);
  assert.match(source, /sourceExecutionId/);
  assert.match(source, /parentWorkId/);
  assert.match(source, /<img alt=/);
  assert.match(source, /<video controls/);
  assert.match(source, /<audio controls/);
});

test('work library is not a generic file manager and does not overwrite history', () => {
  assert.doesNotMatch(source, /导入作品|删除作品|覆盖原文件|保存修改|renameFile|deleteFile/);
});
