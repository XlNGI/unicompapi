import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = await readFile('src/pages/chat/ChatPage.tsx', 'utf8');
const itemStore = await readFile('src/pages/chat/threadItemStore.ts', 'utf8');
const summaryStore = await readFile('src/pages/chat/threadSummaryStore.ts', 'utf8');
const stream = await readFile('src/pages/chat/StreamingItem.tsx', 'utf8');

test('phase 2 keeps summary and Item stores normalized and separate', () => {
  assert.match(page, /ThreadSummaryStore/);
  assert.match(page, /ThreadItemStore/);
  assert.match(itemStore, /itemById/);
  assert.match(itemStore, /orderedItemIds/);
  assert.match(summaryStore, /summaryById/);
  assert.match(summaryStore, /orderedThreadIds/);
});

test('phase 2 uses a single streaming overlay and stable Item row identity', () => {
  assert.match(page, /const streamingMessage = useMemo/);
  assert.match(page, /key=\{`message:\$\{item\.messageId\}`\}/);
  assert.match(page, /previous\.item === next\.item && previous\.rowRevision === next\.rowRevision/);
  assert.match(stream, /StreamingMarkdown/);
});

test('phase 6 retains scroll compensation and uses the measured virtual list', () => {
  assert.match(page, /prependScrollAnchorRef/);
  assert.match(page, /scrollHeight/);
  assert.match(page, /followOutputRef/);
  assert.match(page, /VirtualMessageList/);
});
