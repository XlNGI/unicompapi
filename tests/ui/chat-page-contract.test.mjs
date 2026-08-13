import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile('src/pages/chat/ChatPage.tsx', 'utf8');
const styles = await readFile('src/styles/pages.css', 'utf8');
const appSource = await readFile('src/ui/App.tsx', 'utf8');
const buttonSource = await readFile('src/components/Button.tsx', 'utf8');

test('chat page uses project conversations and composer-first streaming workflow', () => {
  for (const operation of [
    'listConversations',
    'createConversation',
    'copyLegacyConversation',
    'renameConversation',
    'deleteConversation',
    'listTextCandidates',
    'addUserMessage',
    'createResponseDraft',
    'replaceResponseContexts',
    'replaceResponseParameters',
    'prepareResponseSubmission',
    'submitResponse',
    'getResponseExecution',
    'cancelAssistantResponse',
    'getConversation'
  ]) {
    assert.match(source, new RegExp(`chat\\.${operation}\\(`));
  }
  assert.match(source, /runtime_not_allowed/);
  assert.match(source, /replaceResponseParameters/);
  assert.match(source, /已截断/);
  assert.match(source, /finish\.length|输出长度限制被截断/);
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
  assert.match(styles, /uc-chat-page__model-picker-popup/);
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
  assert.match(source, /conversationGroups/);
  assert.match(source, /发送第一条消息后，对话会自动保存在这里/);
  assert.match(source, /<Whisper/);
  assert.match(source, /<Tooltip>\{conversation\.title\}<\/Tooltip>/);
  assert.match(styles, /\.uc-chat-page__history-menu \{[\s\S]*opacity: 0;[\s\S]*pointer-events: none;/);
  assert.match(styles, /\.uc-chat-page__history-row:hover \.uc-chat-page__history-menu/);
  assert.match(styles, /text-overflow: ellipsis/);
  assert.match(styles, /--uc-chat-content-width: 860px/);
  assert.match(styles, /\.uc-chat-page__messages-inner[\s\S]*width: min\(var\(--uc-chat-content-width\), 100%\)/);
  assert.match(styles, /\.uc-chat-page__composer-region[\s\S]*width: min\(var\(--uc-chat-content-width\), calc\(100% - 48px\)\)/);
  assert.match(source, /uc-chat-page__composer-region[\s\S]*\{notice \? \([\s\S]*role="status"[\s\S]*uc-chat-page__composer/);
  assert.doesNotMatch(appSource, /setNewChatRequest|newConversationRequest/);
  assert.match(appSource, /initialConversationId=\{selectedChatConversationId\}/);
  assert.match(appSource, /onConversationChange=\{setSelectedChatConversationId\}/);
  assert.match(source, /onConversationChange\?\.\(selectedId\)/);
  assert.match(source, /speaker=\{<Tooltip>新对话<\/Tooltip>\}[\s\S]*aria-label="新建对话"[\s\S]*onClick=\{startNewConversation\}/);
  assert.match(source, /speaker=\{<Tooltip>对话列表<\/Tooltip>\}/);
  assert.match(source, /speaker=\{<Tooltip>项目上下文<\/Tooltip>\}/);
  assert.match(buttonSource, /forwardRef<HTMLButtonElement, ButtonProps>/);
  assert.match(buttonSource, /ref=\{ref\}/);
  assert.match(styles, /\.uc-chat-page__header-actions \.uc-button \{[\s\S]*width: 32px;[\s\S]*height: 32px;/);
  assert.match(styles, /\.uc-chat-page__composer \{[\s\S]*grid-template-columns: minmax\(0, 1fr\);[\s\S]*grid-template-rows: minmax\(40px, auto\) auto;[\s\S]*min-height: 96px;/);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*\.uc-chat-page__composer \{[\s\S]*min-height: 92px;/);
  assert.match(source, /询问 UniComp AI/);
  assert.match(source, /open=\{contextOpen\}/);
  assert.match(source, /uc-chat-page__delete-dialog/);
  assert.match(source, /停止生成/);
  assert.match(source, /cancelRequested/);
  assert.match(source, /cancelRequestedRef\.current/);
  assert.match(source, /已发出停止请求，正在确认/);
  assert.match(styles, /\.uc-chat-page__model-tool \.rs-picker-toggle \{[\s\S]*border: 0;[\s\S]*border-radius: var\(--uc-radius-full\);[\s\S]*background: transparent;/);
  assert.match(styles, /\.uc-chat-page__model-tool \.rs-picker-toggle:hover/);
  assert.match(source, /responseInProgress/);
  assert.match(source, /displayMessages/);
  assert.match(source, /<MarkdownMessage/);
  assert.match(source, /className="uc-chat-page__message-bubble"/);
  assert.match(styles, /\.uc-chat-page__message-item--user > \.uc-chat-page__message-bubble \{[\s\S]*padding: 8px 12px;[\s\S]*background: var\(--uc-color-surface-subtle\);/);
  assert.match(styles, /\.uc-chat-page__composer \{[\s\S]*background: var\(--uc-color-surface-raised\);[\s\S]*box-shadow: var\(--uc-shadow-md\);/);
  assert.match(styles, /\.uc-chat-page__composer-region \{[\s\S]*position: absolute;[\s\S]*bottom: 0;[\s\S]*left: 50%;[\s\S]*background: transparent;[\s\S]*pointer-events: none;/);
  assert.match(styles, /\.uc-chat-page__messages \{[\s\S]*scroll-padding-bottom: 180px;/);
  assert.match(styles, /\.uc-chat-page__message-list \{[\s\S]*padding-bottom: 180px;/);
  assert.match(styles, /\.uc-chat-page__composer:focus-within \{[\s\S]*border-color: var\(--uc-color-border-default\);[\s\S]*box-shadow: var\(--uc-shadow-md\);/);
  assert.match(source, /item\.state === 'completed'/);
  assert.match(source, /uc-chat-page__scroll-to-bottom/);
  assert.match(source, /failedResponseNotice/);
  assert.match(source, /const RESPONSE_STREAM_POLL_INTERVAL_MS = 200;/);
  assert.match(source, /void pollResponseExecution\(\)/);
  assert.match(source, /RESPONSE_STREAM_POLL_INTERVAL_MS/);
  assert.match(source, /void sendMessage\(\)/);
  assert.match(source, /confirmLeaveUnsentInput/);
  assert.doesNotMatch(source, /首次外发前请核对/);
  assert.doesNotMatch(source, /确认并发送/);
  assert.doesNotMatch(source, /受控文本流/);
  assert.doesNotMatch(source, /保存消息/);
  assert.doesNotMatch(source, /等待保存消息/);
  assert.doesNotMatch(source, /setSelectedCandidateId\(candidates\.value\[0\]/);
  assert.doesNotMatch(source, /chat\.archiveConversation\(/);
  assert.doesNotMatch(source, /chat\.restoreConversation\(/);
  assert.doesNotMatch(source, /新建项目对话|创建项目对话|恢复对话/);
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

test('chat composer does not advertise unsupported attachments', () => {
  assert.doesNotMatch(source, /type="file"|FileReader|fetch\(|upload|localStorage|sessionStorage/);
  assert.doesNotMatch(source, /原生附件登记未进入本支范围|>附件</);
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
  assert.match(source, /正在推理/);
  assert.match(source, /已处理/);
  assert.match(source, /模型返回的思考内容/);
  assert.match(source, /reasoningContent/);
  assert.match(source, /<MarkdownMessage content=\{reasoningContent\}/);
  assert.doesNotMatch(source, /已创建回复请求/);
  assert.doesNotMatch(source, /完整思考过程|模型内心|模拟思考|伪造思考/);
  assert.doesNotMatch(source, /编辑并重新生成|重新生成/);
});

test('chat page does not expose creation or task submission controls', () => {
  assert.doesNotMatch(source, /生成图片|生成视频|提交任务|createTask|submitTask/);
  assert.doesNotMatch(source, /requestAssistantResponse/);
});
