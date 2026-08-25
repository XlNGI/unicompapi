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
  assert.match(page, /\{ value: 'financing', label: '融资演讲稿' \}/);
  assert.match(page, /\{ value: 'university', label: '大学课堂汇报' \}/);
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
  assert.match(page, /ragEnabled/);
  assert.match(page, /检索资料/);
  assert.match(page, /retrieveContext/);
  assert.match(page, /detectDocumentIntent/);
  assert.match(page, /pendingDocumentClarification/);
  assert.match(page, /documentKindInstruction/);
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

test('document composer keeps its controls reachable in the compact chat width', () => {
  assert.match(styles, /\.uc-chat-page__composer-actions\s*\{[\s\S]*?flex-wrap:\s*wrap;/);
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]*?\.uc-chat-page__composer-actions\s*\{[\s\S]*?flex-wrap:\s*wrap;/);
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]*?\.uc-chat-page__doc-kind\s*\{[\s\S]*?max-width:\s*100%;/);
});

test('document response failures retain the safe provider reason after polling', () => {
  assert.match(page, /responseFailureSafeCodeRef/);
  assert.match(page, /failedResponseNotice\(\s*failedMessage,[\s\S]*?failureSafeCode\?\.executionId/);
  assert.match(page, /responseFailureSafeCodeRef\.current = undefined/);
});

test('document submission guards re-entry before React state updates', () => {
  assert.match(page, /documentGenerationInFlightRef/);
  assert.match(page, /if \(documentGenerationInFlightRef\.current\) return;/);
});
