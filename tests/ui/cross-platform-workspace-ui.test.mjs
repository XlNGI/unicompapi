import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const paths = {
  layout: 'src/ui/layout/AppLayout.tsx',
  projects: 'src/pages/projects/ProjectsPage.tsx',
  tasks: 'src/pages/tasks/TasksPage.tsx',
  library: 'src/pages/library/LibraryPage.tsx',
  chat: 'src/pages/chat/ChatPage.tsx',
  providers: 'src/pages/providers/ProvidersPage.tsx',
  image: 'src/pages/creation/image/ImageWorkbenchPage.tsx',
  video: 'src/pages/creation/video/VideoWorkbenchPage.tsx'
};
const sources = Object.fromEntries(
  await Promise.all(
    Object.entries(paths).map(async ([name, path]) => [
      name,
      await readFile(path, 'utf8')
    ])
  )
);

test('the desktop layout owns the only main landmark', () => {
  assert.match(sources.layout, /<main className="workspace" id="main-content"/);
  for (const name of ['projects', 'tasks', 'library', 'chat', 'providers', 'image', 'video']) {
    assert.doesNotMatch(sources[name], /<main(?:\s|>)/, `${name} must not nest a main landmark`);
  }
});

test('global pages consume controlled desktop facts and preserve abnormal states', () => {
  for (const operation of [
    'getProjectSession',
    'listProjects',
    'openProject',
    'createProject',
    'closeProject'
  ]) assert.match(sources.projects, new RegExp(`storage\\.${operation}`));
  assert.match(sources.tasks, /storage\.getTaskDetails/);
  assert.match(sources.library, /storage\.createWorkMediaHandle/);
  assert.match(sources.library, /storage\.revealWorkFile/);
  assert.match(sources.library, /storage\.relinkFile/);
  assert.match(sources.providers, /providersApi\.getRegistry/);
  assert.match(sources.providers, /providersApi\.listTemplates/);
  assert.match(sources.providers, /selectedConnection\.credentialState/);
  assert.match(sources.providers, /adapter_unavailable/);
});

test('A2 pages do not branch on the renderer platform or claim fake work', () => {
  for (const [name, source] of Object.entries(sources)) {
    if (name === 'layout') continue;
    assert.doesNotMatch(
      source,
      /process\.platform|navigator\.platform|navigator\.userAgent/,
      `${name} must rely on shared DTOs instead of platform branches`
    );
  }
  assert.match(sources.chat, /运行授权关闭/);
  assert.match(sources.chat, /当前没有已登记的文本候选/);
  assert.match(sources.image, /不会伪造任务或结果/);
  assert.match(sources.video, /不会伪造进度或结果/);
});
