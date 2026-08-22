import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

const page = await readFile('src/pages/chat/ChatPage.tsx', 'utf8');
const styles = await readFile('src/styles/pages.css', 'utf8');

test('chat page exposes a document generation entry without making chat the only path', () => {
  assert.match(page, /documentMode/);
  assert.match(page, /uc-chat-page__doc-kind/);
  assert.match(page, /\{ value: 'auto', label: '自动' \}/);
  assert.match(page, /\{ value: 'word', label: 'Word' \}/);
  assert.match(page, /\{ value: 'excel', label: 'Excel' \}/);
  assert.match(page, /\{ value: 'ppt', label: 'PPT' \}/);
  assert.match(page, /documentThemeOptions/);
  assert.match(page, /\{ value: 'blueprint', label: '商务蓝' \}/);
  assert.match(page, /theme: documentTheme/);
  assert.match(page, /composeDocumentRevisionInput/);
  assert.match(page, /previousDocument/);
  assert.match(page, /toggleTemplate/);
  assert.match(page, /extractTheme/);
  assert.match(page, /customTheme/);
  assert.match(page, /作为样式模板/);
  assert.match(page, /aiImagesEnabled/);
  assert.match(page, /AI 配图/);
  assert.match(page, /ai_images_unavailable/);
  assert.match(page, /generateAiSlideImages/);
  assert.match(page, /generateQuickImage/);
  assert.match(page, /extractSectionHeadings/);
  assert.match(page, /canAutoGenerateImageCandidate/);
  assert.match(page, /绝对不能出现任何文字/);
  assert.match(page, /imageCandidateOptions/);
  assert.match(page, /selectedImageCandidateId/);
  assert.match(page, /uc-chat-page__image-model/);
  assert.match(page, /documentResult/);
  assert.match(page, /openDocumentWork/);
  assert.match(page, /getPathForFile/);
  assert.match(page, /importAttachment/);
  assert.match(page, /sendDocumentMessage/);
  assert.match(page, /generateFromMessage/);
  assert.match(page, /awaitDocumentCompletion/);
  assert.match(page, /AI 正在撰写文档内容/);
  assert.match(page, /handlePageDrop/);
  assert.match(page, /uc-chat-page__drop-overlay/);
  assert.match(page, /if \(!documentMode\) setDocumentMode\(true\)/);
});

test('chat page document card styles exist', () => {
  assert.match(styles, /\.uc-chat-page__document-card/);
  assert.match(styles, /\.uc-chat-page__attachments/);
  assert.match(styles, /\.uc-chat-page__drop-overlay/);
  assert.match(styles, /\.uc-chat-page__doc-kind/);
});
