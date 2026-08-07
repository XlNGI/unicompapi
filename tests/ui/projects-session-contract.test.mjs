import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile('src/pages/projects/ProjectsPage.tsx', 'utf8');

test('projects page uses the controlled project session API', () => {
  for (const operation of [
    'getProjectSession',
    'listProjects',
    'listTasks',
    'listWorks',
    'createProject',
    'openProject',
    'closeProject'
  ]) {
    assert.match(source, new RegExp(`storage\\.${operation}`));
  }
  assert.match(source, /projectName/);
  assert.match(source, /notifyProjectSessionChanged/);
  assert.doesNotMatch(source, /rootDirectory|absolutePath|readFile|writeFile/);
});

test('projects page represents loading, open, and closed session states', () => {
  assert.match(source, /正在读取项目状态/);
  assert.match(source, /还没有打开的项目/);
  assert.match(source, /项目已打开/);
  assert.match(source, /已取消选择项目/);
});

test('projects page keeps creation project-scoped and does not invent summaries', () => {
  assert.match(source, /请先新建或打开项目，再开始创作/);
  assert.match(source, /最近项目/);
  assert.match(source, /最近任务/);
  assert.match(source, /最近作品/);
  assert.match(source, /当前没有可显示的项目任务/);
  assert.match(source, /当前没有已登记的本地作品/);
  assert.doesNotMatch(source, /mock|fixture|demoProject/i);
});

test('project creation entries use distinct image and video icons', () => {
  assert.match(source, /LuImagePlus/);
  assert.match(source, /LuClapperboard/);
  assert.match(source, /data-entry-kind="image"/);
  assert.match(source, /data-entry-kind="video"/);
  assert.doesNotMatch(source, /<span aria-hidden="true">图<\/span>|<span aria-hidden="true">影<\/span>/);
});

test('project page shows real task, work, and project-level issue summaries', () => {
  assert.match(source, /tasksResult\.value\.items/);
  assert.match(source, /worksResult\.value\.items/);
  assert.match(source, /taskIssues\.map/);
  assert.match(source, /workIssues\.map/);
  assert.match(source, /项目数据损坏/);
});

test('project page exposes unavailable catalog state and accessible form controls', () => {
  assert.match(source, /project\.availability === 'available'/);
  for (const state of ['损坏', '只读', '断盘', '操作失败']) {
    assert.match(source, new RegExp(state));
  }
  assert.match(source, /htmlFor="project-name"/);
  assert.match(source, /aria-live="polite"/);
});
