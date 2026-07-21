import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const navigationSource = await readFile('src/ui/navigation/navigationItems.ts', 'utf8');
const appSource = await readFile('src/ui/App.tsx', 'utf8');
const creationModesSource = await readFile('src/pages/creation/creationModes.ts', 'utf8');
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
  const labels = ['对话', '项目', '图片创作', '视频创作', '任务中心', '作品库', '模型与服务商', '本地设置'];
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
    '快速生图', '专业生图', '图片识别', '图片编辑', '图片转提示词',
    '快速视频', '文生视频', '图生视频', '基础编辑'
  ];
  for (const label of requiredModes) {
    assert.match(creationModesSource, new RegExp(`label: '${label}'`));
  }
  assert.doesNotMatch(creationModesSource, /多图参考|图片批量创作|视频批量创作/);
});
