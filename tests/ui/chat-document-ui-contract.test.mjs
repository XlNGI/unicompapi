import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
const read = file => readFile(file, 'utf8');
const [page, intent, tools, continuation, ipc, preload] = await Promise.all([
  read('src/pages/chat/ChatPage.tsx'), read('src/application/conversation-intent-orchestrator.ts'),
  read('src/platform/documents/conversation-document-tool-session.ts'), read('src/platform/ipc/conversation-agent-continuations.ts'),
  read('src/shared/document-generation-ipc.ts'), read('electron/preload.ts')
]);
test('every conversation intent uses one semantic planner without a local or compatibility route', () => {
  assert.equal(/classifier\.classify\(/.test(intent), true);
  assert.equal(/analyzeLocal|local_compat|agent_first|routingMode|isDocumentDiscussionOnly|hasStrongCreateCommand/.test(intent + continuation), false);
});
test('document tools consume the validated operation and target instead of scanning user prose', () => {
  assert.equal(/plan: workflow\.plan/.test(tools), true);
  assert.equal(/isReadRequest|isMutationRequest|isPptGeneration|conversationDefers|requestedOfficeKind|readScope\(|selectDocument\(/.test(tools), false);
});
test('the renderer has one document executor for both storage modes', () => {
  assert.equal(/sendDocumentMessage|threadFirstExecutionEnabled|parseDeterministicClearRevisionTarget|generateAiSlideImages/.test(page), false);
  assert.equal(/startChatResponse\(composeWorkflowRequirements\(workflow, sourceContent\), conversation, workflow\)/.test(page), true);
});
test('an unavailable agent capability does not fall back to a second workflow sender', () => {
  const block = page.slice(page.indexOf('if (!chat.startAgentResponse)'), page.indexOf('function subscribeStartingCommand'));
  assert.equal(/submitWorkflowInput\(/.test(block), false);
  assert.equal(/setNotice\(/.test(block), true);
});
test('legacy deterministic revision generation is removed from the IPC and preload surface', () => {
  assert.equal(/prepareDeterministicRevision/.test(ipc + preload), false);
});
test('the host preserves scope, file, version and budget verification', () => {
  for (const value of ['checksumSha256', 'userMessageRevision', 'maxToolCalls', 'invalid_inherited_execution_budget', 'this.issued.has']) {
    assert.equal(tools.includes(value), true, value);
  }
});
test('only returned semantic cancellation chooses the cancel workflow', () => {
  assert.equal(/plan.kind === 'cancel'/.test(intent), true);
  assert.equal(/isConversationCancellation|analyzeLocalSafetyIntent/.test(intent), false);
});
test('composer dispatch pins identity, selected model and source context', () => {
  for (const value of ['clientCommandId', 'expectedRevision', 'candidateId: selectedCandidateId', 'contextSelections', 'attachmentFileIds']) assert.equal(page.includes(value), true, value);
});
test('formal document results remain attached to local Work identities', () => {
  for (const value of ['documentResult', 'openDocumentWork', 'file_unavailable', 'verification_failed']) assert.equal(page.includes(value), true, value);
});
test('cancellation and task recovery remain bounded host controls', () => {
  for (const value of ['cancelAgentSession', 'cancelResponseStart', 'resumeFailedWorkflow', 'needs_reconciliation']) assert.equal((page + continuation).includes(value), true, value);
});
