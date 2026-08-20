import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const selector = await readFile('src/pages/creation/WorkspaceContextSelector.tsx', 'utf8');
const image = await readFile('src/pages/creation/image/ImageProfessionalWorkspace.tsx', 'utf8');
const video = await readFile('src/pages/creation/video/VideoTextWorkspace.tsx', 'utf8');
const shared = await readFile('src/shared/chat-context-ipc.ts', 'utf8');

test('image and video workspaces share one controlled context selector', () => {
  assert.match(image, /<WorkspaceContextSelector/);
  assert.match(video, /<WorkspaceContextSelector/);
  assert.match(image, /contextReferences/);
  assert.match(video, /contextReferences/);
  assert.doesNotMatch(image, /当前 DTO 尚未提供三类上下文/);
  assert.doesNotMatch(video, /当前 DTO 没有上下文候选列表/);
});

test('selector honors privacy settings and loads candidates only after explicit action', () => {
  assert.match(selector, /privacy\.readProjectContext/);
  assert.match(selector, /privacy\.readSavedProjectChats/);
  assert.match(selector, /async function openSelector/);
  assert.match(selector, /chat\.listProjectContextCandidates\(\)/);
  assert.match(selector, /chat\.listConversationCandidates\(\)/);
  assert.match(selector, /保存草稿不构成向服务商外发授权/);
  assert.doesNotMatch(selector, /getConversation\(|fetch\(|ipcRenderer|localStorage/);
});

test('professional image uses the compact context action without changing selector privacy', () => {
  assert.match(image, /<WorkspaceContextSelector\s+compact/);
  assert.match(selector, /uc-image-professional__contexts--compact/);
  assert.match(selector, /uc-image-professional__context--compact/);
  assert.match(selector, /uc-image-professional__context-count/);
  assert.match(selector, /compact \? section\.title : section\.action/);
  assert.match(selector, /!compact \? \(/);
});

test('saved conversation candidates contain summaries but no message content', () => {
  const start = shared.indexOf('export interface ConversationCandidateDto');
  const end = shared.indexOf('export interface ProjectContextFragmentDto', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const candidate = shared.slice(start, end);
  assert.match(candidate, /conversationId/);
  assert.match(candidate, /messageCount/);
  assert.match(candidate, /completedMessageCount/);
  assert.doesNotMatch(candidate, /messages:|content:|attachments:|MessageDto/);
});

test('selector pins project contexts while saved conversations remain ID-only', () => {
  assert.match(selector, /\{ kind, referenceId \}/);
  assert.match(selector, /contextRevision,/);
  assert.match(selector, /candidate\.revision\s*\n\s*\)}/);
  assert.match(selector, /includeInPrompt: true/);
  assert.match(image, /projectContextsOnly/);
  assert.match(video, /projectContextsOnly/);
  assert.doesNotMatch(selector, /absolutePath|checksumSha256|apiKey|endpoint|remoteOperationId/);
});
