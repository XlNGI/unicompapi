import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const componentSource = await readFile('src/components/FloatingStatusBar.tsx', 'utf8');
const componentStyles = await readFile('src/styles/components.css', 'utf8');
const appLayoutSource = await readFile('src/ui/layout/AppLayout.tsx', 'utf8');
const taskStatusDockSource = await readFile('src/ui/layout/TaskStatusDock.tsx', 'utf8');
const appStyles = await readFile('src/styles.css', 'utf8');
const statusContext = await readFile('src/ui/status/ProjectStatusContext.tsx', 'utf8');
const imageWorkbenchSource = await readFile(
  'src/pages/creation/image/ImageWorkbenchPage.tsx',
  'utf8'
);
const videoWorkbenchSource = await readFile(
  'src/pages/creation/video/VideoWorkbenchPage.tsx',
  'utf8'
);

test('workspace feedback uses one reusable floating status bar', () => {
  assert.match(componentSource, /export function FloatingStatusBar/);
  assert.match(componentSource, /role = 'status'/);
  assert.match(componentStyles, /\.uc-floating-status-bar \{[\s\S]*position: fixed;/);
  assert.match(componentStyles, /bottom: var\(--uc-space-4\);/);
  assert.match(componentStyles, /left: calc\(200px \+ var\(--uc-space-4\)\);/);
  assert.match(componentStyles, /\.uc-floating-status-bar__content/);
  assert.match(appLayoutSource, /useProjectStatus/);
  assert.match(appLayoutSource, /TaskStatusDock fallbackStatus=\{status\}/);
  assert.match(appStyles, /\.app-body \{[\s\S]*grid-template-rows: minmax\(0, 1fr\) auto;/);
  assert.match(appStyles, /\.uc-project-status-dock \{[\s\S]*grid-row: 2;/);
  assert.match(appStyles, /\.uc-project-status-dock \{[\s\S]*grid-column: 2;/);
  assert.doesNotMatch(appStyles, /\.uc-project-status-bar \{[^}]*position: fixed;/);
  assert.match(appStyles, /\.uc-project-status-bar \{[\s\S]*min-height: 44px;/);
  assert.match(appStyles, /\.uc-project-status-bar \{[\s\S]*padding: var\(--uc-space-2\) var\(--uc-space-3\);/);
  assert.match(taskStatusDockSource, /uc-project-status-bar/);
  assert.match(statusContext, /ProjectStatusProvider/);
  assert.match(statusContext, /priority\?: number/);
  assert.match(appStyles, /\.sidebar \{[\s\S]*grid-row: 1 \/ -1;/);
  assert.match(appStyles, /\.workspace \{[\s\S]*grid-row: 1;/);
});

test('global status dock aggregates concurrent production tasks without fake percentages', () => {
  assert.match(taskStatusDockSource, /useTaskReadStore\(\)/);
  assert.doesNotMatch(taskStatusDockSource, /listTasks\(/);
  assert.match(taskStatusDockSource, /tasksForProject\(tasks, currentProjectId\)/);
  assert.doesNotMatch(taskStatusDockSource, /summarizeTasks\(tasks, now\)/);
  assert.match(taskStatusDockSource, /maximumVisibleTasks = 4/);
  assert.match(taskStatusDockSource, /正在处理 \{summary\.inProgress\} 个任务/);
  assert.match(taskStatusDockSource, /\{summary\.attention\} 个需要处理/);
  assert.match(taskStatusDockSource, /接收并校验/);
  assert.match(taskStatusDockSource, /已下载、校验并保存到本地作品库/);
  assert.match(taskStatusDockSource, /onNavigate\('tasks'\)/);
  assert.match(taskStatusDockSource, /onNavigate\('library'\)/);
  assert.match(taskStatusDockSource, /taskPriority/);
  assert.doesNotMatch(taskStatusDockSource, /Math\.round|percent|百分比|\d+%/);
  assert.match(appStyles, /\.uc-task-status-panel \{[\s\S]*position: absolute;/);
  assert.match(appStyles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.uc-task-status-spinner/);
});

test('expanded task status panel collapses when the user points outside the dock', () => {
  assert.match(taskStatusDockSource, /const dockRef = useRef<HTMLDivElement>\(null\)/);
  assert.match(taskStatusDockSource, /document\.addEventListener\('pointerdown', collapseOnOutsidePointer\)/);
  assert.match(taskStatusDockSource, /!dockRef\.current\?\.contains\(target\)/);
  assert.match(taskStatusDockSource, /setExpanded\(false\)/);
  assert.match(taskStatusDockSource, /document\.removeEventListener\('pointerdown', collapseOnOutsidePointer\)/);
  assert.match(taskStatusDockSource, /className="uc-project-status-dock" ref=\{dockRef\}/);
});

test('image and video workbenches route live messages through the shared status bar', () => {
  assert.match(imageWorkbenchSource, /<FloatingStatusBar>[\s\S]*uc-image-workbench__message/);
  assert.match(videoWorkbenchSource, /<FloatingStatusBar>[\s\S]*uc-image-workbench__message/);
  assert.doesNotMatch(imageWorkbenchSource, /uc-image-workbench__message-card/);
  assert.doesNotMatch(imageWorkbenchSource, /\{message \? \([\s\S]*<FloatingStatusBar>/);
  assert.match(imageWorkbenchSource, /const floatingStatusMessage = blockingReason/);
  assert.match(imageWorkbenchSource, /const \[blockingReason, setBlockingReason\]/);
  assert.match(imageWorkbenchSource, /当前不能生成：\$\{blockingReason\}/);
  assert.match(imageWorkbenchSource, /const handleBlockingReasonChange = useCallback/);
  assert.match(imageWorkbenchSource, /onBlockingReasonChange=\{handleBlockingReasonChange\}/);
});
