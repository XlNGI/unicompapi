import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sharedSource = await readFile('src/shared/chat-context-ipc.ts', 'utf8');
const preloadSource = await readFile('electron/preload.ts', 'utf8');
const registrationSource = await readFile('electron/ipc/chat-context-ipc.ts', 'utf8');
const mainSource = await readFile('electron/main.ts', 'utf8');

const operations = [
  'createConversation',
  'getConversation',
  'listConversations',
  'listConversationCandidates',
  'renameConversation',
  'archiveConversation',
  'restoreConversation',
  'deleteConversation',
  'addUserMessage',
  'editCancelledUserMessage',
  'copyLegacyConversation',
  'createResponseDraft',
  'replaceResponseContexts',
  'replaceResponseParameters',
  'listResponseCandidates',
  'listTextCandidates',
  'prepareResponseSubmission',
  'submitResponse',
  'startResponse',
  'startWorkflow',
  'answerWorkflow',
  'confirmWorkflow',
  'cancelWorkflow',
  'getWorkflow',
  'getPendingWorkflow',
  'getResponseExecution',
  'replayResponseEvents',
  'cancelResponseExecution',
  'subscribeResponseEvents',
  'createContextDraft',
  'getContextDraftPreview',
  'addContextMessageFragment',
  'removeContextMessageFragment',
  'updateContextDraftLabels',
  'registerContextDraft',
  'updateProjectContext',
  'deleteProjectContext',
  'refreshContextSourceStatus',
  'listProjectContextCandidates',
  'getProjectContext',
  'getProjectContextRevision',
  'getContextSourceStatus'
];

test('exposes only the named chat and project-context IPC whitelist', () => {
  for (const operation of operations) {
    assert.match(sharedSource, new RegExp(`\\b${operation}\\b`));
    assert.match(preloadSource, new RegExp(`\\b${operation}:`));
    assert.match(registrationSource, new RegExp(`chatContextIpcChannels\\.${operation}`));
  }
  assert.match(preloadSource, /chatContexts,/);
  assert.match(preloadSource, /afterSequence\s*\n?\s*\}\)\.then/);
  assert.doesNotMatch(preloadSource, /afterSequence:\s*0/);
  assert.match(mainSource, /registerChatContextIpcHandlers/);
  assert.doesNotMatch(sharedSource, /cancelAssistantResponse/);
  assert.doesNotMatch(preloadSource, /cancelAssistantResponse/);
  assert.doesNotMatch(registrationSource, /cancelAssistantResponse/);
  assert.doesNotMatch(sharedSource, /send\(|invoke\(|ipcRenderer|ipcMain/);
});

test('keeps renderer chat contracts free of protected platform facts', () => {
  for (const forbidden of [
    'absolutePath',
    'rootDirectory',
    'checksumSha256',
    'remoteOperationId',
    'apiKey',
    'endpoint',
    'contentHash',
    'routeSnapshot',
    'outboundTextSnapshot',
    'promptContent',
    'stack'
  ]) {
    assert.doesNotMatch(sharedSource, new RegExp(forbidden, 'i'));
  }
  assert.doesNotMatch(sharedSource, /readFile|writeFile|deleteFile|openPath/);
  assert.match(sharedSource, /assetId/);
  assert.match(sharedSource, /fileReferenceId/);
});

test('does not expose generic Electron or Node capabilities through chatContexts', () => {
  const start = preloadSource.indexOf('const chatContexts:');
  const end = preloadSource.indexOf("contextBridge.exposeInMainWorld", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const block = preloadSource.slice(start, end);
  assert.doesNotMatch(block, /require\(|process\.|fs\.|child_process/);
  assert.doesNotMatch(block, /ipcRenderer\s*[:,]|send\s*[:,]|invoke\s*[:,]/);
  assert.doesNotMatch(block, /path\s*[:,]|directory\s*[:,]|url\s*[:,]/i);
});
