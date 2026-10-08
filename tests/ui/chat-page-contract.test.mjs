import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile('src/pages/chat/ChatPage.tsx', 'utf8');
const styles = await readFile('src/styles/pages.css', 'utf8');
const appSource = await readFile('src/ui/App.tsx', 'utf8');
const layoutSource = await readFile('src/ui/layout/AppLayout.tsx', 'utf8');
const shellStyles = await readFile('src/styles.css', 'utf8');
const buttonSource = await readFile('src/components/Button.tsx', 'utf8');
const failureNoticeSource = await readFile(
  'src/ui/chat-response-failure-notice.ts',
  'utf8'
);
const markdownSource = await readFile('src/components/MarkdownMessage.tsx', 'utf8');

test('chat page uses project conversations and composer-first streaming workflow', () => {
  for (const operation of [
    'listConversations',
    'copyLegacyConversation',
    'renameConversation',
    'archiveConversation',
    'restoreConversation',
    'deleteConversation',
    'listTextCandidates',
    'startResponse',
    'startWorkflow',
    'answerWorkflow',
    'confirmWorkflow',
    'cancelWorkflow',
    'getPendingWorkflow',
    'subscribeResponseEvents',
    'cancelResponseExecution',
    'getConversation'
  ]) {
    assert.match(source, new RegExp(`chat\\.${operation}\\(`));
  }
  assert.match(source, /runtime_not_allowed/);
  assert.doesNotMatch(source, /analyzeLocalConversationIntent|analyzeOfficeRequest/);
  assert.match(source, /activeWorkflow/);
  assert.match(source, /workflowSubmissionInFlightRef/);
  assert.match(source, /if \(workflowSubmissionInFlightRef\.current\) return;/);
  assert.match(source, /needs_clarification/);
  assert.match(source, /needs_confirmation/);
  assert.match(source, /PPT 物理第/);
  assert.match(source, /保留：其他页面与原文件不变/);
  assert.match(source, /parameterValues:\s*\{\}/);
  assert.match(source, /已截断/);
  assert.match(failureNoticeSource, /回答达到当前输出长度上限/);
  assert.match(source, /searchPlaceholder="搜索模型或服务商"/);
  assert.match(source, /ariaLabel="模型设置"/);
  assert.match(source, /listTextCandidates\('text_chat'\)/);
  assert.match(source, /listTextCandidates\('text_reasoning'\)/);
  assert.match(source, /responseFeature/);
  assert.match(source, /普通对话/);
  assert.match(source, /深度推理/);
  assert.match(source, /role="radiogroup"/);
  assert.match(source, /<ModelSelect/);
  assert.match(source, /appearance="subtle"/);
  assert.match(source, /listboxMaxHeight=\{250\}/);
  assert.match(source, /<ActionMenu/);
  assert.match(source, /uc-chat-page__composer-toolbar/);
  assert.match(source, /uc-chat-page__model-picker-header/);
  assert.match(source, /uc-chat-page__model-mode/);
  assert.match(source, /onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/);
  assert.match(styles, /uc-chat-page__model-picker-popup/);
  assert.match(styles, /\.uc-chat-page__model-picker-popup[\s\S]*display: grid/);
  assert.match(styles, /\.uc-chat-page__model-picker-popup \.uc-model-select__listbox-composite \{[\s\S]*display: contents;/);
  assert.match(styles, /\.uc-chat-page__model-picker-popup \.rs-search-box/);
  assert.match(styles, /\.uc-chat-page__model-picker-popup \.rs-picker-menu-group-caret \{[\s\S]*display: none;/);
  assert.match(styles, /\.uc-picker-layer \.rs-picker-popup\.uc-chat-page__model-picker-popup/);
  assert.match(source, /<Drawer/);
  assert.match(source, /<Drawer\.Title>对话列表<\/Drawer\.Title>/);
  assert.match(source, /<Drawer\.Title>项目上下文<\/Drawer\.Title>/);
  assert.match(source, /uc-chat-page__side-drawer uc-chat-page__history-drawer/);
  assert.match(source, /uc-chat-page__side-drawer uc-chat-page__context-drawer/);
  assert.match(source, /backdropClassName="uc-chat-page__drawer-backdrop"/);
  assert.match(styles, /\.uc-chat-page__side-drawer\.rs-drawer[\s\S]*top: 42px;[\s\S]*height: calc\(100% - 42px\);/);
  assert.match(styles, /\.uc-chat-page__drawer-backdrop\.rs-drawer-backdrop \{[\s\S]*top: 42px;/);
  assert.match(styles, /\.uc-chat-page__side-drawer \.rs-drawer-header-close \{[\s\S]*width: 32px;[\s\S]*height: 32px;/);
  assert.match(source, /打开对话列表/);
  assert.match(source, /打开项目上下文/);
  assert.match(source, /conversationTitleFromMessage/);
  assert.match(source, /aria-label="搜索聊天"/);
  assert.match(source, /发送第一条消息后，对话会自动保存在这里/);
  assert.match(source, /<Whisper/);
  assert.match(source, /<Tooltip>\{conversation\.title\}<\/Tooltip>/);
  assert.match(styles, /\.uc-chat-page__history-menu \{[\s\S]*opacity: 0;[\s\S]*pointer-events: none;/);
  assert.match(styles, /\.uc-chat-page__history-row:hover \.uc-chat-page__history-menu/);
  assert.match(styles, /text-overflow: ellipsis/);
  assert.match(styles, /--uc-chat-content-width: 760px/);
  assert.match(styles, /\.uc-chat-page__messages-inner[\s\S]*width: min\(var\(--uc-chat-content-width\), 100%\)/);
  assert.match(styles, /\.uc-chat-page__composer-region[\s\S]*width: min\(var\(--uc-chat-content-width\), calc\(100% - 48px\)\)/);
  assert.match(source, /uc-chat-page__messages-inner[\s\S]*aria-label="助手任务回复"[\s\S]*\{notice \? \([\s\S]*role="status"[\s\S]*uc-chat-page__composer-region/);
  assert.doesNotMatch(appSource, /setNewChatRequest|newConversationRequest/);
  assert.match(appSource, /initialConversationId=\{selectedChatConversationId\}/);
  assert.match(appSource, /onConversationChange=\{setSelectedChatConversationId\}/);
  assert.match(appSource, /initialModelSelection=\{chatModelSelection\}/);
  assert.match(appSource, /onModelSelectionChange=\{setChatModelSelection\}/);
  assert.match(source, /onConversationChange\?\.\(selectedId\)/);
  assert.match(source, /onModelSelectionChange\?\.\(modelSelection\)/);
  assert.match(source, /initialModelSelection\?: ChatModelSelection/);
  assert.match(source, /onModelSelectionChange\?: \(selection\?: ChatModelSelection\) => void/);
  assert.match(source, /candidate\?\.available \? current : undefined/);
  assert.match(source, /speaker=\{<Tooltip>新聊天<\/Tooltip>\}[\s\S]*aria-label="新聊天"[\s\S]*onClick=\{startNewConversation\}/);
  assert.match(source, /speaker=\{<Tooltip>对话列表<\/Tooltip>\}/);
  assert.match(source, /speaker=\{<Tooltip>项目上下文<\/Tooltip>\}/);
  assert.match(buttonSource, /forwardRef<HTMLButtonElement, ButtonProps>/);
  assert.match(buttonSource, /ref=\{ref\}/);
  assert.match(styles, /\.uc-chat-page__header-actions \.uc-button \{[\s\S]*width: 32px;[\s\S]*height: 32px;/);
  assert.match(styles, /\.uc-chat-page__composer \{[\s\S]*grid-template-columns: minmax\(0, 1fr\);[\s\S]*grid-template-rows: minmax\(40px, auto\) auto;[\s\S]*min-height: 96px;/);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*\.uc-chat-page__composer \{[\s\S]*min-height: 92px;/);
  assert.match(source, /输入问题或任务，可拖入图片、文档或电子书/);
  assert.match(source, /open=\{contextOpen\}/);
  assert.match(source, /uc-chat-page__delete-dialog/);
  assert.match(source, /停止生成/);
  assert.match(source, /cancelRequested/);
  assert.match(source, /cancelRequestedRef\.current/);
  assert.match(source, /editingMessageId/);
  assert.match(source, /编辑并重新发送/);
  assert.match(source, /restoreCancelledInput/);
  assert.match(source, /editedMessageId:\s*commandEditingMessageId \?\? null/);
  assert.match(source, /已发出停止请求，正在确认/);
  assert.doesNotMatch(source, /chat\.cancelAssistantResponse\(/);
  assert.doesNotMatch(source, /state:\s*'cancelled'/);
  assert.match(styles, /\.uc-chat-page__model-tool \.rs-picker-toggle \{[\s\S]*border: 0;[\s\S]*border-radius: var\(--uc-radius-full\);[\s\S]*background: transparent;/);
  assert.match(styles, /\.uc-chat-page__model-tool \.rs-picker-toggle:hover/);
  assert.match(source, /responseInProgress/);
  assert.match(source, /displayMessages/);
  assert.match(source, /<StreamingMarkdown/);
  assert.match(source, /className="uc-chat-page__message-bubble"/);
  assert.match(styles, /\.uc-chat-page__message-item--user > \.uc-chat-page__message-bubble \{[\s\S]*padding: 8px 12px;[\s\S]*background: var\(--uc-color-surface-subtle\);/);
  assert.match(styles, /\.uc-chat-page__composer \{[\s\S]*background: var\(--uc-color-surface-raised\);[\s\S]*box-shadow: var\(--uc-shadow-md\);/);
  assert.match(styles, /\.uc-chat-page__composer-region \{[\s\S]*position: absolute;[\s\S]*bottom: 0;[\s\S]*left: 50%;[\s\S]*transform: translateX\(-50%\);[\s\S]*background: transparent;[\s\S]*pointer-events: none;/);
  assert.match(styles, /\.uc-chat-page__messages \{[\s\S]*scroll-padding-bottom: 180px;/);
  assert.match(styles, /\.uc-chat-page__messages-inner \{[\s\S]*padding-bottom: 180px;/);
  assert.match(styles, /\.uc-chat-page__composer:focus-within \{[\s\S]*border-color: var\(--uc-color-border-default\);[\s\S]*box-shadow: var\(--uc-shadow-md\);/);
  assert.match(source, /item\.state === 'completed'/);
  assert.match(source, /uc-chat-page__scroll-to-bottom/);
  assert.match(source, /failedResponseNotice/);
  assert.match(source, /failedResponseNotice\(assistant, event\.safeCode\)/);
  assert.match(failureNoticeSource, /模型请求未正常完成/);
  assert.match(source, /chat\.subscribeResponseEvents\(/);
  assert.match(source, /subscribeResponseEvents\(executionId, latestSequence, onEvent\)/);
  assert.match(source, /event\.sequence <= latestSequence/);
  assert.match(source, /window\.requestAnimationFrame\(flushEvents\)/);
  assert.match(source, /const keepActiveResponse = Boolean\([\s\S]*activeConversationId === selected\?\.conversationId/);
  assert.match(source, /if \(!keepActiveResponse\) \{[\s\S]*clearResponseDraftState\(\);/);
  assert.match(markdownSource, /memo\(function MarkdownMessage/);
  assert.match(markdownSource, /const markdownComponents/);
  assert.doesNotMatch(source, /RESPONSE_STREAM_POLL_INTERVAL_MS/);
  assert.match(source, /void sendMessage\(\)/);
  assert.match(source, /confirmLeaveUnsentInput/);
  assert.doesNotMatch(source, /首次外发前请核对/);
  assert.doesNotMatch(source, /确认并发送/);
  assert.doesNotMatch(source, /受控文本流/);
  assert.doesNotMatch(source, /保存消息/);
  assert.doesNotMatch(source, /等待保存消息/);
  assert.doesNotMatch(source, /setSelectedCandidateId\(candidates\.value\[0\]/);
  assert.match(source, /chat\.listConversations\(true, false\)/);
  assert.match(source, /uc-chat-page__workspace-sidebar/);
  assert.match(source, /storage\.listProjects\(\)/);
  assert.match(source, /storage\.openRecentProject\(projectId\)/);
  assert.match(source, /<Button[\s\S]*新建项目/);
  assert.match(styles, /\.uc-chat-page\s*\{[\s\S]*grid-template-columns: 260px minmax\(0, 1fr\);/);
  assert.match(styles, /\.uc-chat-page__workspace-sidebar\s*\{[\s\S]*grid-column: 1;/);
  assert.match(appSource, /\(activeItemId === 'chat' \|\| activeItemId === 'projects'\) && !activeSubItemId/);
  assert.equal((appSource.match(/<ChatPage\b/g) ?? []).length, 1);
  assert.match(appSource, /hidden=\{!chatVisible\}/);
  assert.match(source, /hidden=\{hidden\}/);
  assert.match(styles, /\.uc-chat-page\[hidden\]\s*\{[^}]*display:\s*none;/);
  assert.match(source, /key: 'archive'/);
  assert.match(source, /key: 'restore'/);
  assert.doesNotMatch(source, /新建项目对话|创建项目对话/);
  assert.doesNotMatch(source, /当前项目[^\n]*条消息/);
  assert.doesNotMatch(source, /history-resizer|history-collapsed|toggleHistorySidebar|--uc-chat-history-width/);
  assert.doesNotMatch(source, /运行授权关闭/);
  assert.doesNotMatch(source, /DynamicParameterForm/);
  assert.doesNotMatch(source, /推理强度|>高级</);
  assert.doesNotMatch(source, /回复已接收。若内容偏短/);
  assert.doesNotMatch(source, /新的对话已准备好/);
  assert.doesNotMatch(source, /请查看任务中心调用记录/);
  assert.doesNotMatch(source, /消息内容已复制/);
  assert.doesNotMatch(source, /上下文 \{includedContextIds\.length\}/);
});

test('chat workspace uses a quiet project list and search dialog', () => {
  assert.match(source, /aria-label="新聊天"/);
  assert.match(source, /aria-label="搜索项目或对话"/);
  assert.match(source, /LuSquarePen/);
  assert.match(source, /LuFolder/);
  assert.match(source, /打开本地项目/);
  assert.match(source, /Alt\+\$\{index \+ 1\}/);
  assert.doesNotMatch(source, /搜索文件/);
  assert.doesNotMatch(source, /<h4>\{label\}<\/h4>/);
  assert.doesNotMatch(source, /当前项目 · \{conversations\.length\} 个对话/);
  assert.match(styles, /\.uc-chat-page__new-conversation\s*\{[^}]*width: calc\(100% - var\(--uc-space-4\)\);/);
  assert.doesNotMatch(styles, /\.uc-chat-page__new-conversation\s*\{[^}]*width: fit-content;/);
  assert.match(styles, /\.uc-chat-page__new-conversation[\s\S]*background: transparent/);
  assert.match(source, /registerProjectSwitchGuard/);
  assert.match(styles, /\.uc-chat-page__header-new/);
  assert.match(source, /function onProjectRowClick\(projectId: string\)/);
  assert.match(source, /expandedProjectIds/);
  assert.match(source, /listProjectConversationSummaries\(projectId\)/);
  assert.match(source, /function openProjectConversation\(projectId: string, conversationId: string\)/);
  assert.doesNotMatch(source, /function switchProject/);
  assert.match(source, /retainProjectOrder\(current, projectsResult\.value\)/);
  assert.match(source, /aria-expanded=\{expanded\}/);
  assert.doesNotMatch(source, /isCurrent && projectChatsExpanded/);
  assert.match(source, /uc-chat-page__workspace-scroll uc-scrollbar/);
  assert.match(styles, /\.uc-scrollbar,[\s\S]*scrollbar-width: thin/);
  assert.match(styles, /\.uc-chat-page__project-item\s*\{[\s\S]*min-height: 28px/);
  assert.doesNotMatch(styles, /\.uc-chat-page__workspace-conversations\s*\{[^}]*max-height:/);
  assert.match(layoutSource, /activeItemId === 'chat' \|\| activeItemId === 'projects' \? ' workspace--chat'/);
  assert.match(shellStyles, /\.workspace--chat\s*\{[\s\S]*padding:\s*0;/);
  assert.match(styles, /\.uc-chat-page__messages-inner\s*\{[\s\S]*margin: 0 auto;/);
  assert.match(styles, /\.uc-chat-page__empty\s*\{[\s\S]*place-items: center;[\s\S]*text-align: center;/);
  assert.match(styles, /\.uc-chat-page__conversation\s*\{[\s\S]*gap: 0;/);
  assert.match(styles, /\.uc-chat-search__dialog/);
});

test('chat copy uses the desktop clipboard bridge before the browser fallback', () => {
  assert.match(source, /window\.unicomp\?\.clipboard\?\.writeText/);
  assert.match(source, /复制失败，请手动选择消息内容。/);
});

test('chat composer imports images through the controlled attachment API', () => {
  assert.doesNotMatch(source, /type="file"|fetch\(|upload|localStorage|sessionStorage/);
  assert.doesNotMatch(source, /原生附件登记未进入本支范围|>附件</);
  assert.match(source, /onPaste=/);
  assert.match(source, /documentAttachments\.importAttachment/);
  assert.match(source, /本条消息的附件/);
});

test('project context uses a single explicit registration action and separates use from deletion', () => {
  for (const operation of [
    'createContextDraft',
    'addContextMessageFragment',
    'removeContextMessageFragment',
    'updateContextDraftLabels',
    'registerContextDraft',
    'updateProjectContext',
    'deleteProjectContext'
  ]) {
    assert.match(source, new RegExp(`chat\\.${operation}\\(`));
  }
  assert.match(source, /message\.state === 'completed'/);
  assert.match(source, /message\.content\.length/);
  assert.match(source, /草稿预览/);
  assert.match(source, /上下文名称/);
  assert.match(source, /添加标签（可选）/);
  assert.match(source, /登记并用于本次回复/);
  assert.match(source, /contextDisplayName/);
  assert.match(source, /composeContextLabels/);
  assert.match(source, /getProjectContextRevision/);
  assert.match(source, /toggleContextUsage/);
  assert.match(source, /本次使用/);
  assert.match(source, /上下文库/);
  assert.match(source, /从本次移除/);
  assert.match(source, /从上下文库删除/);
  assert.match(source, /uc-chat-page__context-card-menu/);
  assert.match(source, /引用版本不会被改写/);
  assert.doesNotMatch(source, /草稿预览 · 版本|保存名称与标签|我已检查目标项目|确认登记到项目|查看固定版本|取消引用/);
});

test('chat transparency only reports observable execution state', () => {
  assert.match(source, /aria-label="回复状态"/);
  assert.match(source, /正在组织回答/);
  assert.match(source, /正在思考/);
  assert.match(source, /回复已完成/);
  assert.match(source, /isCurrentAssistant && !showProductionProgress/);
  assert.doesNotMatch(source, /AI 工作过程|模型返回的思考内容|activityExpanded|setActivityExpanded/);
  assert.doesNotMatch(source, /<(?:MarkdownMessage|StreamingMarkdown)[^>]*content=\{(?:item\.)?reasoningContent\}/);
  assert.doesNotMatch(source, /已创建回复请求/);
  assert.doesNotMatch(source, /完整思考过程|模型内心|模拟思考|伪造思考/);
  assert.doesNotMatch(source, /编辑并重新生成|重新生成/);
});

test('expanded execution trace does not take the live reply off its isolated renderer', () => {
  const directStream = source.match(/const directStream = Boolean\([\s\S]*?\);/)?.[0] ?? '';
  assert.match(directStream, /isCurrentAssistant/);
  assert.match(directStream, /responseInProgress/);
  assert.match(directStream, /!isDocumentDraftMessage/);
  assert.match(directStream, /!hideDocumentDraftContent/);
  assert.match(directStream, /!taskProgress\?\.length/);
  assert.doesNotMatch(directStream, /showProductionProgress/);
  assert.match(source, /execution=\{responseExecution!\}/);
  assert.doesNotMatch(source, /execution=\{streamedHere/);
  assert.match(source, /if \(hidden\) return;/);
});

test('chat page does not expose creation or task submission controls', () => {
  assert.doesNotMatch(source, /生成图片|生成视频|提交任务|createTask|submitTask/);
  assert.doesNotMatch(source, /requestAssistantResponse/);
});
