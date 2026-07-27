import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = await readFile('src/pages/settings/SettingsPage.tsx', 'utf8');
const styles = await readFile('src/styles/pages.css', 'utf8');

test('A1 keeps the ten frozen settings categories in order', () => {
  const labels = [
    '常规', '存储与文件', '任务与性能', '本地媒体处理', '隐私与权限',
    '网络与代理', '通知', '快捷键', '日志与诊断', '应用更新'
  ];
  let previous = -1;
  for (const label of labels) {
    const current = page.indexOf(`label: '${label}'`);
    assert.ok(current > previous, `${label} should keep its frozen order`);
    previous = current;
  }
});

test('A1 uses only the controlled B1 snapshot and save operations', () => {
  assert.match(page, /settings\.getSnapshot\(\)/);
  assert.match(page, /settings\.updateValues\(snapshot\.revision, nextValues\)/);
  assert.match(page, /settings\.planOperation\(snapshot\.revision/);
  assert.match(page, /settings\.executeOperation\(operationPlan\.confirmationHandle\)/);
  assert.doesNotMatch(page, /localStorage|sessionStorage|fetch\(|process\.platform|navigator\.platform/);
});

test('A1 exposes honest save, recovery and unavailable states', () => {
  for (const text of [
    '已自动保存', '保存中', '保存失败', '设置冲突',
    '重试保存', '重新载入最新设置', '平台适配器尚未接入',
    '未接平台适配器的分类只显示不可用，不提供假控件'
  ]) {
    assert.match(page, new RegExp(text));
  }
  assert.match(page, /settings_write_failed/);
  assert.match(page, /revision_conflict/);
  assert.match(page, /settings_persistence/);
});

test('A1 keeps controls accessible and layout responsive', () => {
  assert.match(page, /aria-label="本地设置分类"/);
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /aria-modal="true"|showModal\(\)/);
  assert.match(page, /type="search"/);
  assert.match(styles, /\.uc-settings__workspace/);
  assert.match(styles, /@media \(max-width: 1500px\)/);
  assert.match(styles, /@media \(max-width: 1180px\)/);
});
