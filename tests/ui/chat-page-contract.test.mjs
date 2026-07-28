import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile('src/pages/chat/ChatPage.tsx', 'utf8');

test('chat page uses persisted conversation operations and honest adapter failure', () => {
  for (const operation of [
    'listConversations',
    'createConversation',
    'renameConversation',
    'archiveConversation',
    'restoreConversation',
    'deleteConversation',
    'addUserMessage',
    'requestAssistantResponse'
  ]) {
    assert.match(source, new RegExp(`chat\\.${operation}\\(`));
  }
  assert.match(source, /adapter_unavailable/);
  assert.match(source, /不会生成或伪造 AI 回复、进度或费用/);
  assert.match(source, /消息已保存；尚未配置真实适配器，因此没有创建 AI 回复/);
});

test('chat attachments remain unavailable until a controlled native port exists', () => {
  assert.match(source, /disabled title="原生附件登记将在独立小 PR 实现"/);
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
  assert.match(source, /保存对话和登记项目上下文是两个独立操作/);
});

test('chat page does not expose creation or task submission controls', () => {
  assert.doesNotMatch(source, /生成图片|生成视频|提交任务|createTask|submitTask/);
});
