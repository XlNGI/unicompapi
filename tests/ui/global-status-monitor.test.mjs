import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const monitor = await readFile('src/ui/layout/GlobalStatusMonitor.tsx', 'utf8');
const sidebar = await readFile('src/ui/layout/Sidebar.tsx', 'utf8');
const styles = await readFile('src/styles.css', 'utf8');

test('global shell monitor reads real storage and task projections', () => {
  assert.match(sidebar, /GlobalStatusMonitor/);
  assert.match(monitor, /storageApi\.listTasks\(\)/);
  assert.match(monitor, /settingsApi\.getSystemStatus\(\)/);
  assert.match(monitor, /window\.setInterval\(refresh, 5_000\)/);
  assert.match(monitor, /window\.setInterval\(refresh, 60_000\)/);
  assert.doesNotMatch(monitor, /1\.48|2\.00|236/);
});

test('task activity bar exposes truthful summary, recent activity and navigation', () => {
  for (const label of [
    '本地存储', '最近任务活动', '运行中', '需处理', '等待处理', '已完成',
    '最近变化', '打开任务中心', '状态待确认'
  ]) assert.match(monitor, new RegExp(label));
  assert.match(monitor, /aria-expanded=\{expanded\}/);
  assert.match(monitor, /onOpenTasks/);
  assert.match(styles, /\.global-status-monitor/);
});
