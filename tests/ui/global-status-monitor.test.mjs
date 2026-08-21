import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const monitor = await readFile('src/ui/layout/GlobalStatusMonitor.tsx', 'utf8');
const taskStatusDock = await readFile('src/ui/layout/TaskStatusDock.tsx', 'utf8');
const sidebar = await readFile('src/ui/layout/Sidebar.tsx', 'utf8');
const styles = await readFile('src/styles.css', 'utf8');
const storageIpc = await readFile('electron/ipc/storage-ipc.ts', 'utf8');
const readModel = await readFile('src/platform/ipc/global-read-model-controller.ts', 'utf8');

test('global shell monitor reads real storage and task projections', () => {
  assert.match(sidebar, /GlobalStatusMonitor/);
  assert.match(monitor, /storageApi\.listTasks\(\)/);
  assert.match(monitor, /storageApi\.getLocalStorageSummary\(\)/);
  assert.match(monitor, /storageApi\?\.onLocalStorageChanged/);
  assert.match(monitor, /PROJECT_SESSION_CHANGED_EVENT/);
  assert.match(monitor, /window\.setInterval\(refresh, 5_000\)/);
  assert.doesNotMatch(monitor, /appUsage|settingsApi\.getSystemStatus|1\.48|2\.00|236/);
});

test('project storage monitoring is event-driven with a periodic fallback', () => {
  assert.match(storageIpc, /watch\(entry\.rootDirectory, \{ recursive: true \}/);
  assert.match(storageIpc, /this\.scheduleChange\(\)/);
  assert.match(storageIpc, /}, 750\)/);
  assert.match(storageIpc, /}, 60_000\)/);
  assert.match(storageIpc, /projectStorageMonitor\.dispose\(\)/);
  assert.match(readModel, /scanDirectoryUsage\(entry\.rootDirectory\)/);
  assert.match(readModel, /availableBytes\(current\.rootDirectory\)/);
  assert.match(readModel, /projectUsageCache/);
});

test('task activity bar exposes only truthful compact status counts', () => {
  for (const label of [
    '本地存储', '全部项目占用', '当前磁盘可用', '当前项目', '监控正常',
    '最近任务活动', '运行中', '需处理', '等待处理', '已完成'
  ]) assert.match(monitor, new RegExp(label));
  assert.match(monitor, /aria-expanded=\{expanded\}/);
  assert.match(monitor, /summarizeTasks\(tasks \?\? \[\], Date\.now\(\)\)/);
  assert.match(taskStatusDock, /visibleTerminalDurationMs = 10 \* 60 \* 1_000/);
  assert.match(taskStatusDock, /visibleActiveDurationMs = 60 \* 60 \* 1_000/);
  assert.match(taskStatusDock, /task\.latestExecutionState === 'failed'/);
  assert.match(taskStatusDock, /if \(!state\) return 'inactive'/);
  assert.match(taskStatusDock, /'created', 'queued', 'validating_sources'/);
  assert.doesNotMatch(monitor, /最近变化|打开任务中心|onOpenTasks|taskUpdatedAt|executionStateLabel/);
  assert.doesNotMatch(sidebar, /onOpenTasks/);
  assert.match(styles, /\.global-status-monitor/);
});

test('task counts refresh from project file changes with a periodic fallback', () => {
  assert.match(monitor, /const unsubscribeTasks = storageApi\?\.onLocalStorageChanged\(handleTaskChange\)/);
  assert.match(monitor, /window\.addEventListener\(PROJECT_SESSION_CHANGED_EVENT, handleTaskChange\)/);
  assert.match(monitor, /unsubscribeTasks\?\.\(\)/);
  assert.match(monitor, /aria-live="polite"/);
  assert.match(monitor, /aria-atomic="true"/);
});

test('sidebar keeps the status cards in a fixed dock while only navigation scrolls', () => {
  assert.match(sidebar, /className="sidebar__status-dock"/);
  assert.match(styles, /\.sidebar \{[\s\S]*?overflow: hidden;/);
  assert.match(styles, /\.nav-list \{[\s\S]*?overflow-y: auto;/);
  assert.match(styles, /\.sidebar__status-dock \{[\s\S]*?flex: 0 0 auto;/);
  assert.match(styles, /\.sidebar__status-dock::before/);
});

test('sidebar navigation uses a compact theme-aware scrollbar', () => {
  assert.match(styles, /\.nav-list::\-webkit-scrollbar \{/);
  assert.match(styles, /\.nav-list::\-webkit-scrollbar-thumb \{/);
  assert.match(styles, /\.nav-list::\-webkit-scrollbar-thumb:hover \{/);
  assert.match(styles, /\.nav-list::\-webkit-scrollbar-button \{/);
  assert.match(styles, /scrollbar-width: thin;/);
  assert.match(styles, /scrollbar-color:/);
});
