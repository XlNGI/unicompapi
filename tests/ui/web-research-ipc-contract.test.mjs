import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sharedSource = await readFile('src/shared/web-research-ipc.ts', 'utf8');
const preloadSource = await readFile('electron/preload.ts', 'utf8');
const registrationSource = await readFile('electron/ipc/chat-context-ipc.ts', 'utf8');
const chatSource = await readFile('src/pages/chat/ChatPage.tsx', 'utf8');

test('exposes only controlled web research operations through preload and main IPC', () => {
  for (const operation of ['preview', 'authorize', 'cancel', 'getStatus']) {
    assert.match(sharedSource, new RegExp(`\\b${operation}:`));
    assert.match(preloadSource, new RegExp(`\\b${operation}:`));
    assert.match(registrationSource, new RegExp(`webResearchIpcChannels\\.${operation}`));
  }
  assert.match(chatSource, /允许联网检索/);
  assert.match(chatSource, /planHash/);
  assert.match(chatSource, /authorization_required/);
});

test('does not expose endpoint, credential or absolute path fields in the web DTO', () => {
  assert.doesNotMatch(sharedSource, /apiKey|credentialReference|absolutePath|rootDirectory|endpoint/);
  assert.match(sharedSource, /querySummary/);
  assert.match(sharedSource, /allowedDomains/);
  assert.match(sharedSource, /planHash/);
});
