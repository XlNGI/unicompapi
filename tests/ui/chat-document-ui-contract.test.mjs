import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

const page = await readFile('src/pages/chat/ChatPage.tsx', 'utf8');
const styles = await readFile('src/styles/pages.css', 'utf8');
const progress = await readFile('src/pages/chat/DocumentProgress.tsx', 'utf8');
const failureNoticeSource = await readFile(
  'src/ui/chat-response-failure-notice.ts',
  'utf8'
);

test('chat page exposes a document generation entry without making chat the only path', () => {
  assert.doesNotMatch(page, /documentMode|setDocumentKind|intentHint/);
  assert.doesNotMatch(page, /aria-label="(?:文档类型|文档主题|PPT 模板)"/);
  assert.doesNotMatch(page, /uc-chat-page__(?:doc-mode|doc-kind|image-model|presentation-template)/);
  assert.match(page, /输入问题或任务，可拖入图片、文档或电子书/);
  assert.match(page, /kind === 'ppt'[\s\S]*?presentationTemplate/);
  assert.match(page, /kind !== 'ppt'[\s\S]*?theme: documentTheme/);
  assert.match(page, /composeDocumentRevisionInput/);
  assert.match(page, /previousDocument/);
  assert.match(
    page,
    /previousDocument\?\.documentResult\?\.validatedContent\s*\?\?\s*previousDocument\?\.content/
  );
  assert.doesNotMatch(page, /toggleTemplate/);
  assert.doesNotMatch(page, /extractTheme/);
  assert.doesNotMatch(page, /customTheme/);
  assert.doesNotMatch(page, /作为样式模板/);
  assert.match(page, /aiImagesRequested/);
  assert.match(page, /AI 配图/);
  assert.match(page, /ai_images_unavailable/);
  assert.match(page, /generateAiSlideImages/);
  assert.match(page, /generateQuickImage/);
  assert.match(page, /extractSectionHeadings/);
  assert.match(page, /canAutoGenerateImageCandidate/);
  assert.match(page, /绝对不能出现任何文字/);
  assert.doesNotMatch(page, /documentAttachments\.retrieveContext/);
  assert.match(page, /attachmentFileIds/);
  assert.match(page, /cancelUnsupportedWebWorkflow/);
  assert.match(page, /preview\.value\.status === 'unavailable'[\s\S]*cancelUnsupportedWebWorkflow/);
  assert.match(page, /cancelUnsupportedWebWorkflow[\s\S]*webResearch\.cancel/);
  assert.match(page, /setWebResearchSession\(undefined\)/);
  assert.match(page, /任务已取消，未执行/);
  assert.match(page, /chat\.startWorkflow\(/);
  assert.match(page, /chat\.answerWorkflow\(/);
  assert.doesNotMatch(page, /analyzeOfficeRequest|analyzeLocalConversationIntent/);
  assert.match(page, /documentKindInstruction/);
  assert.match(page, /documentResult/);
  assert.match(page, /openDocumentWork/);
  assert.match(page, /getPathForFile/);
  assert.match(page, /importAttachment/);
  assert.match(page, /sendDocumentMessage/);
  assert.match(page, /generateFromMessage/);
  assert.match(page, /cancelGeneration/);
  assert.match(page, /document_layout_overflow/);
  assert.match(page, /page_count_mismatch/);
  assert.match(page, /revision_scope_violation/);
  assert.match(page, /revision_patch_failed/);
  assert.match(page, /unvalidated_output/);
  assert.match(page, /\u539f\u6587\u4ef6\u672a\u6539\u53d8/);
  assert.match(
    page,
    /case 'revision_scope_violation':[\s\S]*?case 'revision_patch_failed':[\s\S]*?case 'unvalidated_output'/
  );
  assert.match(page, /generation_cancelled/);
  assert.match(page, /本次文档未交付，已有作品保留/);
  assert.match(page, /新版文档已保存，结果状态同步未完成/);
  assert.match(page, /input_required/);
  assert.match(page, /重试同步/);
  assert.match(page, /实际页码：第/);
  assert.doesNotMatch(page, /文档生成失败，未保存文件/);
  assert.match(page, /awaitDocumentCompletion/);
  assert.match(page, /正在准备文档内容/);
  assert.match(page, /handlePageDrop/);
  assert.match(page, /uc-chat-page__drop-overlay/);
  assert.doesNotMatch(page, /if \(!documentMode\) setDocumentMode\(true\)/);
  assert.doesNotMatch(page, /attachment\.preview\.slice/);
});

test('all composer sends use the semantic workflow entry and accept pending task cancellation', () => {
  assert.doesNotMatch(page, /sendDocumentMessage\(\)/);
  assert.doesNotMatch(page, /submitWorkflowInput\(true\)/);
  assert.doesNotMatch(page, /intentHint/);
  assert.match(page, /chat\.startWorkflow\(/);
  assert.match(page, /workflow\.status === 'cancelled'[\s\S]*?setActiveWorkflow\(undefined\)/);
  assert.doesNotMatch(page, /activeWorkflow && activeWorkflow\.status !== 'needs_clarification'/);
  assert.match(page, /semanticCandidate/);
  assert.match(page, /resetComposerScope/);
});

test('composer rejects missing models before planning and keeps stop controls independent', () => {
  const submit = page.slice(page.indexOf('async function submitWorkflowInput()'), page.indexOf('async function executeReadyWorkflow'));
  assert.match(submit, /if \(!selectedCandidateId \|\| !selectedCandidate\?\.available\) \{\s*setNotice\(errorMessages\.model_selection_required\);\s*return;/);
  assert.ok(submit.indexOf('model_selection_required') < submit.indexOf('setPlanningActive(true)'));
  assert.match(page, /: !chat \|\|\s*!canCompose \|\|\s*!selectedCandidate\?\.available/);
  assert.match(page, /planningActive\s*\? void cancelWorkflowPlanning\(\)/);
});

test('chat page document card styles exist', () => {
  assert.match(styles, /\.uc-chat-page__document-card/);
  assert.match(styles, /\.uc-chat-page__attachments/);
  assert.match(styles, /\.uc-chat-page__drop-overlay/);
});

test('document settings come from this workflow request instead of persistent composer switches', () => {
  assert.match(page, /documentPresentationPreferences\(execution\.requirements\)/);
  assert.match(page, /resolvePresentationTemplate\(\s*'auto',\s*requirements\s*\)/);
  assert.match(page, /useInternalSources: workflow\.plan\.sourcePolicy === 'internal'/);
  assert.doesNotMatch(page, /setAiImagesEnabled|setRagEnabled|setPresentationTemplate/);
  assert.match(page, /if \(!requested\) return \[\];/);
  assert.match(page, /window\.confirm\([\s\S]*?可能消耗模型额度/);
});

test('document outline generation uses one model response and local application recovery', () => {
  assert.match(page, /documentResponseParameterValues\(modelCandidate\)/);
  assert.doesNotMatch(page, /buildDocumentOutlineRepairInput/);
  assert.doesNotMatch(page, /chat-doc-repair/);
  assert.doesNotMatch(page, /outlineRepairAttempted/);
  assert.doesNotMatch(page, /大纲格式异常/);
  assert.match(page, /workflow:\s*\{[\s\S]*?workflowId:/);
  assert.doesNotMatch(page, /displayContent: requirements/);
  assert.doesNotMatch(page, /documentDraftMessageIds/);
  assert.match(page, /documentGenerationStatus/);
  assert.match(page, /文档生成失败/);
  assert.match(page, /文档已生成并保存/);
  assert.match(page, /<DocumentProgress/);
});

test('document outline payload is never rendered as ordinary chat markdown', () => {
  assert.match(page, /documentResponseActive/);
  assert.match(page, /hideDocumentDraftContent/);
  assert.match(page, /isMachineReadableDocumentOutline/);
  assert.match(page, /showProductionProgress = isDocumentDraftMessage \|\| hideDocumentDraftContent/);
  assert.match(page, /setDocumentResponseActive\(true\)/);
  assert.match(page, /setDocumentResponseActive\(false\)/);
  assert.match(page, /showProductionProgress \? \(\s*<DocumentProgress/);
});

test('production trace is expanded by default and legacy task progress stays compatible', () => {
  assert.equal((page.match(/<DocumentProgress\b/g) ?? []).length, 1);
  assert.match(page, /taskProgress=\{taskProgress\}/);
  assert.match(page, /events=\{traceEvents\}/);
  assert.match(page, /productionTrace\.subscribeCommand/);
  assert.match(page, /productionTrace\.subscribe\(selectedId/);
  assert.match(page, /productionTrace\.list\(selectedId\)/);
  assert.match(progress, /aria-label="生产进度"/);
  assert.match(progress, /<ol className="uc-chat-production-trace" aria-label="完整生产链路">/);
  assert.match(progress, /events\.map\(\(event\) =>/);
  assert.match(progress, /data-status=\{event.status\}/);
  assert.match(progress, /本地 → 模型/);
  assert.match(progress, /模型 → 本地/);
  assert.match(progress, /生产记录不完整/);
  assert.match(progress, /taskProgress\.filter\(\(event\) => event\.progressStatus === 'completed'\)/);
  assert.match(progress, /completedSteps\.length > 0/);
  assert.match(progress, /查看已完成步骤/);
  assert.doesNotMatch(progress, /生成步骤|步骤\s*\d|stepLabels|progressSteps|生成大纲.*校验.*生成文件/);
  assert.doesNotMatch(page, /AI 工作过程|模型返回的思考内容/);
});

test('document production exposes readable body content without rendering the raw outline', () => {
  assert.match(page, /bodyContent=\{\(isDocumentDraftMessage \|\| hideDocumentDraftContent\)/);
  assert.match(page, /item\.documentResult\?\.validatedContent \?\? item\.content/);
  assert.match(page, /bodyStreaming=\{item\.state === 'streaming'/);
  assert.match(progress, /aria-label="生成正文"/);
  assert.match(progress, /projectDocumentBody\(bodyContent \?\? ''\)/);
  assert.match(progress, /<StreamingMarkdown content=\{body\} streaming allowImages=\{false\} \/>/);
  assert.match(progress, /<MarkdownMessage content=\{body\} allowImages=\{false\} \/>/);
});

test('document execution consumes the validated workflow plan without re-parsing in React', () => {
  assert.match(page, /executeReadyWorkflow/);
  assert.match(page, /workflow\.plan\.kind === 'document'/);
  assert.match(page, /workflow\.plan\.action === 'revise'/);
  assert.match(page, /sendDocumentMessage\(\{[\s\S]*?workflow,[\s\S]*?kind,[\s\S]*?action/);
  assert.doesNotMatch(page, /analyzeOfficeRequest|analyzeLocalConversationIntent/);
});

test('a single confirmed clear revision bypasses provider response generation safely', () => {
  assert.match(page, /parseDeterministicClearRevisionTarget/);
  assert.match(page, /prepareDeterministicRevision\(\{/);
  assert.match(
    page,
    /useDeterministicLocalRevision[\s\S]*?prepareDeterministicRevision[\s\S]*?generateFromMessage/
  );
  assert.match(page, /workflowTarget\.ordinal === deterministicTarget\.ordinal/);
  assert.match(page, /execution\.workflow\.plan\.sourcePolicy === 'none'/);
  assert.match(page, /attachments\.length === 0/);
  assert.match(page, /这项文档任务需要模型生成内容，请选择一个可用模型后继续/);
});

test('composer resolves Office revisions in the background without a persistent action preview', () => {
  assert.doesNotMatch(page, /Office 操作预览/);
  assert.doesNotMatch(page, /修改上一版/);
  assert.doesNotMatch(page, /officePreview/);
  assert.doesNotMatch(page, /uc-chat-page__office-intent/);
  assert.doesNotMatch(styles, /\.uc-chat-page__office-intent/);
  assert.match(page, /targetMessageId/);
  assert.match(page, /workflow\.plan\.targetHint/);
  assert.match(page, /workflowQuestion/);
  assert.match(page, /needs_clarification/);
});

test('document submission refreshes one stale revision without another click', () => {
  assert.match(page, /会话刚刚更新，正在同步后继续生成/);
  assert.match(page, /started = await startDocumentResponse\(refreshed\.value\)/);
  assert.doesNotMatch(page, /会话已更新并刷新，请再次发送/);
});

test('document composer keeps its controls reachable in the compact chat width', () => {
  assert.match(styles, /\.uc-chat-page__composer-actions\s*\{[\s\S]*?flex-wrap:\s*wrap;/);
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]*?\.uc-chat-page__composer-actions\s*\{[\s\S]*?flex-wrap:\s*wrap;/);
  assert.doesNotMatch(styles, /\.uc-chat-page__doc-kind/);
});

test('document response failures retain the safe provider reason after polling', () => {
  assert.match(page, /responseFailureSafeCodeRef/);
  assert.match(page, /failedResponseNotice\(\s*failedMessage,[\s\S]*?failureSafeCode\?\.executionId/);
  assert.match(page, /responseFailureSafeCodeRef\.current = undefined/);
  assert.match(
    failureNoticeSource,
    /controlledCode\?\.includes\('timeout'\) \|\| message\?\.failureReason === 'unknown'/
  );
  assert.match(failureNoticeSource, /远端状态和费用可能已经产生/);
  assert.match(failureNoticeSource, /避免立即重复发送/);
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
