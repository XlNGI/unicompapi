import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile('src/pages/chat/ChatPage.tsx', 'utf8');

test('chat page reports the real offline and unconfigured state', () => {
  assert.match(source, /服务未配置/);
  assert.match(source, />离线</);
  assert.match(source, /不会生成或伪造 AI 回复/);
  assert.match(source, /disabled>服务未配置，无法发送/);
});

test('chat attachments stay in the current page and are not uploaded', () => {
  assert.match(source, /type="file"/);
  assert.match(source, /multiple/);
  assert.match(source, /file\.name/);
  assert.match(source, /当前输入、附件和未保存草稿不会出现在项目页或创作页/);
  assert.doesNotMatch(source, /upload|fetch\(|localStorage|sessionStorage/);
});

test('project context requires explicit selection, review and save capability', () => {
  assert.match(source, /storage\.getProjectSession\(\)/);
  assert.match(source, /只有用户明确选择的内容才能进入草稿/);
  assert.match(source, /检查后才可保存到项目/);
  assert.match(source, /disabled>没有可保存的上下文/);
});

test('chat page does not expose creation or task submission controls', () => {
  assert.doesNotMatch(source, /生成图片|生成视频|提交任务|createTask|submitTask/);
});
