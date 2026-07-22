import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile('src/ui/navigation/navigationItems.ts', 'utf8');

test('project page is the default without changing primary navigation order', () => {
  assert.match(source, /defaultNavigationItemId: NavigationItemId = 'projects'/);
  assert.ok(source.indexOf("id: 'chat'") < source.indexOf("id: 'projects'"));
});
