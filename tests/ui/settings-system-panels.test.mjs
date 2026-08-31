import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = await readFile('src/pages/settings/SettingsPage.tsx', 'utf8');
const styles = await readFile('src/styles/pages.css', 'utf8');

test('A2 consumes the controlled B2 status and operation ports', () => {
  assert.match(page, /settings\.getSystemStatus\(\)/);
  assert.match(page, /settings\.selectDirectory\(purpose\)/);
  for (const kind of [
    'migrate_directory', 'cleanup_storage', 'update_performance',
    'update_hardware_acceleration'
  ]) {
    assert.match(page, new RegExp(`kind: '${kind}'`));
  }
  assert.doesNotMatch(page, /localStorage|sessionStorage|fetch\(|process\.platform|navigator\.platform/);
});

test('A2 renders the three real system panels without fake production capabilities', () => {
  for (const text of [
    '默认保存位置', '本机应用数据', '清理可重建文件', '文件命名与冲突处理',
    '性能模式', '任务并发', '后台运行与电源', '任务恢复',
    '本地媒体引擎', '真实能力范围', '硬件加速与回退', '预览代理文件'
  ]) {
    assert.match(page, new RegExp(text));
  }
  assert.match(page, /仅本地开发\/测试/);
  assert.match(page, /硬件失败不会阻断软件导出/);
  assert.match(page, /优先硬件（未获批准）/);
  assert.doesNotMatch(page, />修复组件<|>测试硬件加速</);
});

test('A2 shows real impact, blockers and one-time confirmation before execution', () => {
  assert.match(page, /plan\.impact\?\.fileCount/);
  assert.match(page, /plan\.impact\?\.bytes/);
  assert.match(page, /plan\.impact\?\.activeTasksUnaffected/);
  assert.match(page, /plan\.impact\?\.oldLocationRetained/);
  assert.match(page, /plan\.blockers\.length/);
  assert.match(page, /disabled=\{busy \|\| plan\.blockers\.length > 0\}/);
  assert.match(page, /settings\.executeOperation\(operationPlan\.confirmationHandle\)/);
});

test('A2 keeps controls accessible and responsive', () => {
  assert.match(page, /role="radiogroup" aria-label="性能模式"/);
  assert.match(page, /aria-label="媒体硬件加速策略"/);
  assert.match(page, /Toggle as RSuiteToggle/);
  assert.match(page, /<Checkbox/);
  assert.match(styles, /\.uc-settings__metric-grid/);
  assert.match(styles, /\.uc-settings__cleanup-grid/);
  assert.match(styles, /@media \(max-width: 720px\)/);
});
