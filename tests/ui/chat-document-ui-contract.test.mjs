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
  assert.match(page, /presentationTemplateOptions/);
  assert.match(page, /\{ value: 'work_report', label: '工作汇报' \}/);
  assert.match(page, /\{ value: 'natural_minimal', label: '自然简约' \}/);
  assert.match(page, /\{ value: 'business_minimal', label: '极简商务' \}/);
  assert.match(page, /\{ value: 'technology', label: '科技风' \}/);
  assert.match(page, /\{ value: 'financing', label: '融资演讲稿' \}/);
  assert.match(page, /kind === 'ppt'[\s\S]*?presentationTemplate/);
  assert.match(page, /kind !== 'ppt'[\s\S]*?theme: documentTheme/);
  assert.match(page, /composeDocumentRevisionInput/);
  assert.match(page, /previousDocument/);
  assert.doesNotMatch(page, /toggleTemplate/);
  assert.doesNotMatch(page, /extractTheme/);
  assert.doesNotMatch(page, /customTheme/);
  assert.doesNotMatch(page, /作为样式模板/);
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
  assert.match(page, /analyzeOfficeRequest/);
  assert.doesNotMatch(page, /pendingDocumentClarification/);
  assert.match(page, /documentKindInstruction/);
  assert.match(page, /documentResult/);
  assert.match(page, /openDocumentWork/);
  assert.match(page, /getPathForFile/);
  assert.match(page, /importAttachment/);
  assert.match(page, /sendDocumentMessage/);
  assert.match(page, /generateFromMessage/);
  assert.match(page, /cancelGeneration/);
  assert.match(page, /document_layout_overflow/);
  assert.match(page, /generation_cancelled/);
  assert.match(page, /文档生成或写入失败，未登记作品/);
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

test('PPT template selection follows the resolved composer kind', () => {
  assert.doesNotMatch(
    page,
    /\{documentMode \?\s*\(\s*<div\s+aria-label="文档主题"/
  );
  assert.match(
    page,
    /\{documentMode && composerDocumentKind !== 'ppt' \?\s*\(\s*<div\s+aria-label="文档主题"/
  );
});

test('PPT mode keeps the document type switch available', () => {
  assert.match(
    page,
    /\{documentMode \?\s*\(\s*<div\s+aria-label="文档类型"/
  );
  assert.doesNotMatch(
    page,
    /\{documentMode && documentKind !== 'ppt' \?\s*\(\s*<div\s+aria-label="文档类型"/
  );
});

test('PPT template picker defaults to automatic matching and opens above the composer', () => {
  assert.match(page, /useState<PresentationTemplateSelection>\('auto'\)/);
  assert.match(page, /\{ value: 'auto', label: '自动匹配' \}/);
  assert.match(page, /aria-label="PPT 模板"/);
  assert.match(page, /placement="topStart"/);
  assert.match(page, /preventOverflow/);
  assert.match(
    page,
    /resolvePresentationTemplate\(\s*presentationTemplate,\s*requirements\s*\)/
  );
  assert.doesNotMatch(
    page,
    /<details className="uc-chat-page__image-model uc-chat-page__presentation-template"/
  );
  assert.doesNotMatch(
    page,
    /uc-chat-page__image-model-menu uc-chat-page__presentation-template-menu/
  );
});

test('document outline generation uses one model response and local application recovery', () => {
  assert.match(page, /documentResponseParameterValues\(selectedCandidate\)/);
  assert.doesNotMatch(page, /buildDocumentOutlineRepairInput/);
  assert.doesNotMatch(page, /chat-doc-repair/);
  assert.doesNotMatch(page, /outlineRepairAttempted/);
  assert.doesNotMatch(page, /大纲格式异常/);
  assert.match(page, /displayContent: requirements/);
  assert.doesNotMatch(page, /documentDraftMessageIds/);
  assert.match(page, /documentGenerationStatus/);
  assert.match(page, /文档生成失败/);
  assert.match(page, /Office 文档已生成/);
});

test('document outline payload is never rendered as ordinary chat markdown', () => {
  assert.match(page, /documentResponseActive/);
  assert.match(page, /hideDocumentDraftContent/);
  assert.match(page, /isMachineReadableDocumentOutline/);
  assert.match(page, /isDocumentDraftMessage \|\| hideDocumentDraftContent/);
  assert.match(page, /setDocumentResponseActive\(true\)/);
  assert.match(page, /setDocumentResponseActive\(false\)/);
  assert.match(page, /documentResponseActive\s*\|\|\s*hideDocumentDraftContent/);
});

test('document intent passes the resolved kind without waiting for React state', () => {
  assert.match(page, /analyzeOfficeRequest/);
  assert.match(page, /sendDocumentMessage\([\s\S]*?documentIntent\.action/);
  assert.match(page, /resolvedKind \?\?/);
});

test('composer resolves Office revisions in the background without a persistent action preview', () => {
  assert.doesNotMatch(page, /Office 操作预览/);
  assert.doesNotMatch(page, /修改上一版/);
  assert.doesNotMatch(page, /officePreview/);
  assert.doesNotMatch(page, /uc-chat-page__office-intent/);
  assert.doesNotMatch(styles, /\.uc-chat-page__office-intent/);
  assert.match(page, /targetMessageId/);
  assert.match(page, /officeDocuments/);
  assert.match(page, /unresolvedMissing/);
  assert.match(page, /请补充：\$\{unresolvedMissing\.join\('、'\)\}/);
});

test('document submission refreshes one stale revision without another click', () => {
  assert.match(page, /会话刚刚更新，正在同步后继续生成/);
  assert.match(page, /started = await startDocumentResponse\(refreshed\.value\)/);
  assert.doesNotMatch(page, /会话已更新并刷新，请再次发送/);
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
  assert.match(
    page,
    /safeCode\?\.includes\('timeout'\) \|\| message\?\.failureReason === 'unknown'/
  );
  assert.match(page, /远端状态和费用可能已经产生/);
  assert.match(page, /避免立即重复发送/);
});

test('document submission guards re-entry before React state updates', () => {
  assert.match(page, /documentGenerationInFlightRef/);
  assert.match(page, /if \(documentGenerationInFlightRef\.current\) return;/);
});

test('document response cancellation stays available while document orchestration is busy', () => {
  assert.match(
    page,
    /responseInProgress\s*\?\s*cancelRequested\s*:\s*!chat/
  );
  assert.doesNotMatch(
    page,
    /responseInProgress\s*\?\s*busy\s*\|\|\s*cancelRequested/
  );
  assert.doesNotMatch(
    page,
    /!responseInProgress\s*\|\|\s*busy\s*\|\|\s*cancelRequested/
  );
});
