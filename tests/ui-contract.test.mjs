import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const navigationSource = await readFile('src/ui/navigation/navigationItems.ts', 'utf8');
const appSource = await readFile('src/ui/App.tsx', 'utf8');
const creationModesSource = await readFile('src/pages/creation/creationModes.ts', 'utf8');
const sidebarSource = await readFile('src/ui/layout/Sidebar.tsx', 'utf8');
const pageFiles = [
  'src/pages/chat/ChatPage.tsx',
  'src/pages/projects/ProjectsPage.tsx',
  'src/pages/image-creation/ImageCreationPage.tsx',
  'src/pages/video-creation/VideoCreationPage.tsx',
  'src/pages/tasks/TasksPage.tsx',
  'src/pages/library/LibraryPage.tsx',
  'src/pages/providers/ProvidersPage.tsx',
  'src/pages/settings/SettingsPage.tsx'
];

test('keeps the eight required top-level navigation labels in order', () => {
  const labels = ['项目', '对话', '图片创作', '视频创作', '任务中心', '作品库', '模型与服务商', '本地设置'];
  let previousIndex = -1;
  for (const label of labels) {
    const index = navigationSource.indexOf(`label: '${label}'`);
    assert.ok(index > previousIndex, `navigation label missing or out of order: ${label}`);
    previousIndex = index;
  }
});

test('maps every top-level navigation id to a page component', () => {
  for (const id of ['chat', 'projects', 'image-creation', 'video-creation', 'tasks', 'library', 'providers', 'settings']) {
    assert.match(appSource, new RegExp(`['"]?${id}['"]?:`));
  }
});

test('keeps all top-level page components present', async () => {
  for (const path of pageFiles) {
    await readFile(path, 'utf8');
  }
});

test('does not reintroduce prohibited top-level entries', () => {
  assert.doesNotMatch(navigationSource, /首页|登录|会员|充值|云同步/);
});

test('defines only the required image and video creation modes', () => {
  const requiredModes = [
    ['quick-image', '快速生图'],
    ['professional-image', '专业生图'],
    ['image-understanding', '图片识别'],
    ['image-editing', '图片编辑'],
    ['image-to-prompt', '图片转提示词'],
    ['quick-video', '快速视频'],
    ['text-to-video', '文生视频'],
    ['image-to-video', '图生视频'],
    ['video-editing', '基础编辑']
  ];
  let previousIndex = -1;
  for (const [id, label] of requiredModes) {
    const idIndex = creationModesSource.indexOf(`id: '${id}'`);
    const labelIndex = creationModesSource.indexOf(`label: '${label}'`, idIndex);
    assert.ok(idIndex > previousIndex, `creation mode missing or out of order: ${id}`);
    assert.ok(labelIndex > idIndex, `creation mode label does not match id: ${id}`);
    previousIndex = labelIndex;
  }
  assert.doesNotMatch(creationModesSource, /多图参考|图片批量创作|视频批量创作/);
});

test('uses creation modes as the single source for secondary navigation', () => {
  assert.match(navigationSource, /imageCreationModes\.map/);
  assert.match(navigationSource, /videoCreationModes\.map/);
  assert.doesNotMatch(navigationSource, /id: 'quick-image'|label: '快速生图'/);
});

test('maps every secondary navigation id to a page component', () => {
  for (const id of [
    'quick-image',
    'professional-image',
    'image-understanding',
    'image-editing',
    'image-to-prompt',
    'quick-video',
    'text-to-video',
    'image-to-video',
    'video-editing'
  ]) {
    assert.match(appSource, new RegExp(`['"]${id}['"]:`));
  }
});

test('does not expose prohibited secondary navigation entries', () => {
  const navigationContract = `${navigationSource}\n${creationModesSource}\n${appSource}`;
  assert.doesNotMatch(
    navigationContract,
    /多图参考|图片批量创作|视频批量创作/
  );
});

test('renders navigation as accessible icon dropdowns', () => {
  assert.match(sidebarSource, /role="group"/);
  assert.match(sidebarSource, /aria-label=\{`\$\{item\.label\}二级导航`\}/);
  assert.doesNotMatch(sidebarSource, /createPortal/);
  for (const id of [
    'chat',
    'projects',
    'image-creation',
    'video-creation',
    'tasks',
    'library',
    'providers',
    'settings'
  ]) {
    assert.match(sidebarSource, new RegExp(`['"]?${id}['"]?:`));
  }
  for (const id of [
    'quick-image',
    'professional-image',
    'image-understanding',
    'image-editing',
    'image-to-prompt',
    'quick-video',
    'text-to-video',
    'image-to-video',
    'video-editing'
  ]) {
    assert.match(sidebarSource, new RegExp(`['"]${id}['"]:`));
  }
});

test('keeps an expanded creation parent open and returns to its first mode', () => {
  assert.match(
    appSource,
    /setActiveSubItemId\(getSecondaryNavigationItems\(itemId\)\[0\]\?\.id\)/
  );
});
