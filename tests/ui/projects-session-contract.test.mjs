import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile('src/pages/projects/ProjectsPage.tsx', 'utf8');

test('projects page uses the controlled project session API', () => {
  for (const operation of ['getProjectSession', 'openProject', 'closeProject']) {
    assert.match(source, new RegExp(`storage\\.${operation}`));
  }
  assert.match(source, /projectName/);
  assert.doesNotMatch(source, /rootDirectory|absolutePath|readFile|writeFile/);
});

test('projects page represents loading, open, and closed session states', () => {
  assert.match(source, /正在读取项目状态/);
  assert.match(source, /还没有打开的项目/);
  assert.match(source, /项目已打开/);
  assert.match(source, /已取消选择项目/);
});
