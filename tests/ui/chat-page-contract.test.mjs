import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile('src/pages/chat/ChatPage.tsx', 'utf8');

test('chat page uses project conversations and the explicit text response workflow', () => {
  for (const operation of [
    'listConversations',
    'createConversation',
    'copyLegacyConversation',
    'renameConversation',
    'archiveConversation',
    'restoreConversation',
    'deleteConversation',
    'addUserMessage',
    'createResponseDraft',
    'replaceResponseContexts',
    'listResponseCandidates',
    'prepareResponseSubmission',
    'submitResponse',
    'getResponseExecution'
  ]) {
    assert.match(source, new RegExp(`chat\\.${operation}\\(`));
  }
  assert.match(source, /运行授权关闭/);
  assert.match(source, /runtime_not_allowed/);
  assert.match(source, /选择模型/);
  assert.match(source, /aria-label="选择文本模型"/);
  assert.match(source, /请选择模型/);
  assert.match(source, /disabled=\{!candidate\.available\}/);
  assert.doesNotMatch(source, /setSelectedCandidateId\(candidates\.value\[0\]/);
});

test('chat attachments remain unavailable until a controlled native port exists', () => {
  assert.match(source, /disabled title="原生附件登记未进入本支范围"/);
  assert.doesNotMatch(source, /type="file"|FileReader|fetch\(|upload|localStorage|sessionStorage/);
});

test('project context requires completed-message selection, preview and confirmation', () => {
  for (const operation of [
    'createContextDraft',
    'addContextMessageFragment',
    'removeContextMessageFragment',
    'updateContextDraftLabels',
    'registerContextDraft'
  ]) {
    assert.match(source, new RegExp(`chat\\.${operation}\\(`));
  }
  assert.match(source, /message\.state === 'completed'/);
  assert.match(source, /message\.content\.length/);
  assert.match(source, /草稿预览/);
  assert.match(source, /我已检查目标项目、消息内容和标签/);
  assert.match(source, /确认登记到项目/);
  assert.match(source, /查看上下文不会自动用于回复/);
  assert.match(source, /getProjectContextRevision/);
  assert.match(source, /disabled=\{!viewed\}/);
});

test('chat page does not expose creation or task submission controls', () => {
  assert.doesNotMatch(source, /生成图片|生成视频|提交任务|createTask|submitTask/);
  assert.doesNotMatch(source, /requestAssistantResponse/);
});
