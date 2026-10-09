import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const pages = await readFile('src/styles/pages.css', 'utf8');
const shell = await readFile('src/styles.css', 'utf8');
const videoText = await readFile('src/pages/creation/video/VideoTextWorkspace.tsx', 'utf8');
const chat = await readFile('src/pages/chat/ChatPage.tsx', 'utf8');
const editor = await readFile('src/pages/creation/video/VideoEditingPage.tsx', 'utf8');

test('one shared scrollbar rule covers containers, textareas, and picker menus', () => {
  assert.match(pages, /textarea::-webkit-scrollbar,[\s\S]*?width: 6px;/);
  assert.match(pages, /textarea::-webkit-scrollbar-button,[\s\S]*?display: none !important;/);
  assert.match(pages, /\.uc-chat-page__model-picker-popup \.rs-picker-listbox::-webkit-scrollbar,/);
  assert.match(pages, /\.uc-picker-layer \.rs-picker-popup::-webkit-scrollbar,/);
  assert.match(pages, /\.uc-markdown-message pre::-webkit-scrollbar,/);
  assert.doesNotMatch(shell, /\.nav-list::-webkit-scrollbar/);
  assert.doesNotMatch(pages, /\.uc-chat-page__history-list::-webkit-scrollbar/);
  assert.doesNotMatch(pages, /\.uc-chat-page__workspace-scroll::-webkit-scrollbar/);
});

test('the video final prompt remains a textarea covered by the shared scrollbar rule', () => {
  assert.match(videoText, /<h2>最终提示词<\/h2>[\s\S]*as="textarea"/);
  assert.match(pages, /(^|\n)textarea,/);
  assert.match(chat, /className="uc-chat-page__messages uc-scrollbar"/);
  assert.match(chat, /className="uc-chat-page__history-list uc-scrollbar"/);
  assert.match(editor, /className="uc-video-editor__timeline-viewport uc-scrollbar"/);
  assert.match(editor, /className="uc-video-editor__media-list uc-scrollbar"/);
});
