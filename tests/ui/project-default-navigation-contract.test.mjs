import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile('src/ui/navigation/navigationItems.ts', 'utf8');

test('project page is the default and precedes chat in primary navigation', () => {
  assert.match(source, /defaultNavigationItemId: NavigationItemId = 'projects'/);
  assert.ok(source.indexOf("id: 'projects'") < source.indexOf("id: 'chat'"));
});
