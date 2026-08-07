import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile('src/pages/library/LibraryPage.tsx', 'utf8');
const styles = await readFile('src/styles/pages.css', 'utf8');

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

test('work cards lazily show controlled image and video covers without opening details', () => {
  assert.match(source, /IntersectionObserver/);
  assert.match(source, /storage\.createWorkMediaHandle\(work\.workId\)/);
  assert.match(source, /<img alt="" loading="lazy"/);
  assert.match(source, /<video muted playsInline preload="metadata"/);
});

test('work list keeps at least three columns and protects long names from status badges', () => {
  assert.match(styles, /\.uc-work-library__grid \{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@container work-library-list \(min-width: 760px\)[\s\S]*?repeat\(4/);
  assert.match(styles, /@container work-library-list \(min-width: 980px\)[\s\S]*?repeat\(5/);
  assert.match(source, /className="uc-work-library__work-state"/);
  assert.match(source, /<strong title=\{work\.name\}>/);
  assert.match(styles, /\.uc-work-library__work-heading strong \{[\s\S]*?-webkit-line-clamp: 2/);
  assert.match(styles, /padding-right: 76px/);
  assert.match(styles, /\.uc-work-library__work-state \{[\s\S]*?position: absolute;[\s\S]*?right: 0/);
});

test('work library is not a generic file manager and does not overwrite history', () => {
  assert.doesNotMatch(source, /导入作品|删除作品|覆盖原文件|保存修改|renameFile|deleteFile/);
});
