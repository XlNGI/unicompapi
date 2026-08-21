import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

const page = await readFile('src/pages/chat/ChatPage.tsx', 'utf8');
const styles = await readFile('src/styles/pages.css', 'utf8');

test('chat page exposes a document generation entry without making chat the only path', () => {
  assert.match(page, /documentMode/);
  assert.match(page, /自动判断/);
  assert.match(page, /Word 文档/);
  assert.match(page, /Excel 表格/);
  assert.match(page, /PPT 演示/);
  assert.match(page, /documentResult/);
  assert.match(page, /openDocumentWork/);
  assert.match(page, /getPathForFile/);
  assert.match(page, /importAttachment/);
  assert.match(page, /sendDocumentMessage/);
});

test('chat page document card styles exist', () => {
  assert.match(styles, /\.uc-chat-page__document-card/);
  assert.match(styles, /\.uc-chat-page__attachments/);
});
