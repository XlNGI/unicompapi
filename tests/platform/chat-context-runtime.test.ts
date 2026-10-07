import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addUserMessage,
  appendAssistantMessageChunk,
  attachDocumentResultToMessage,
  beginAssistantMessage,
  completeAssistantMessage,
  createConversation,
  createConversationResponseExecution,
  createConversationResponseStreamEvent,
  createConversationAgentRun,
  attachConversationAgentRunExecution,
  markConversationAgentRunNeedsReconciliation,
  setDocumentGenerationStatusOnMessage,
  startAssistantMessageStreaming,
  toConnectionId,
  toConversationId,
  toConversationAgentRunId,
  toConversationResponseDraftId,
  toConversationResponseExecutionId,
  toConversationResponseStreamEventId,
  toIsoTimestamp,
  toMessageId,
  toModelId,
  toProjectContextDraftId,
  toProjectContextFragmentId,
  toProjectContextId,
  toProjectId,
  toProtocolBindingId,
  toProviderExecutionRouteSnapshotId,
  toProviderId,
  toProviderInvocationAttemptId,
  toWorkId,
  type Conversation,
  type DocumentGenerationStatus
} from '../../src/domain';
import { ConversationIntentOrchestrator, ConversationWorkflowService } from '../../src/application';
import { ConversationAgentSessionService } from '../../src/application/conversation-agent-session-service';
import { JsonConversationAgentSessionRepository } from '../../src/platform/repositories/json-conversation-agent-session-repository';
import { JsonConversationAgentRunRepository } from '../../src/platform/repositories/json-conversation-agent-run-repository';
import { JsonConversationCompletionJournal } from '../../src/platform/repositories/json-conversation-completion-journal';
import { JsonConversationResponseExecutionRepository, JsonConversationWorkflowRepository, JsonProjectConversationRepository } from '../../src/platform/repositories';
import { NodeProjectStorage } from '../../src/platform/storage';
import { ConversationDocumentInputStore } from '../../src/platform/documents/conversation-document-inputs';
import {
  createChatContextRuntime,
  type StorageProjectSession
} from '../../src/platform';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createLocalDocumentRecoveryFixture(options: {
  readonly documentStatus?: DocumentGenerationStatus;
  readonly responseState?: 'completed' | 'streaming' | 'interrupted' | 'pending';
  readonly assistantCompleted?: boolean;
  readonly mismatchedResponseSource?: boolean;
  readonly storedInputs?: 'valid' | 'missing' | 'invalid';
} = {}) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'unicomp-local-recover-project-'));
  const userData = await mkdtemp(path.join(os.tmpdir(), 'unicomp-local-recover-user-'));
  roots.push(projectRoot, userData);
  const projectId = toProjectId('project-local-recover');
  const conversationId = toConversationId('conversation-local-recover');
  const sourceId = toMessageId('source-local-recover');
  const assistantId = toMessageId('assistant-local-recover');
  const previousAssistantId = toMessageId('assistant-previous-word');
  const executionId = toConversationResponseExecutionId('response-local-recover');
  const previousWorkId = toWorkId('work-previous-word');
  const t0 = toIsoTimestamp('2026-09-09T00:00:00.000Z');
  const content = '已完成的演示文稿正文';
  const storage = new NodeProjectStorage(projectRoot);
  const conversations = new JsonProjectConversationRepository(storage, projectId);
  let conversation: Conversation = createConversation({ id: conversationId, projectId, title: '恢复本地文档', createdAt: t0 });
  await conversations.create(conversation);
  const save = async (next: Conversation) => {
    await conversations.save(next, conversation.revision);
    conversation = next;
  };
  await save(addUserMessage(conversation, { id: sourceId, content: '做一份 Word 和 PPT', createdAt: t0 }));
  for (const messageId of [previousAssistantId, assistantId]) {
    await save(beginAssistantMessage(conversation, { id: messageId, createdAt: t0 }));
    await save(startAssistantMessageStreaming(conversation, messageId, t0));
    await save(appendAssistantMessageChunk(conversation, messageId, content, t0));
    if (messageId === previousAssistantId || options.assistantCompleted !== false) {
      await save(completeAssistantMessage(conversation, messageId, t0));
    }
    if (messageId === previousAssistantId) {
      await save(attachDocumentResultToMessage(conversation, messageId, {
        kind: 'word', workId: previousWorkId, fileName: '已完成.docx', sizeBytes: 100, validatedContent: content
      }, t0));
    }
  }
  if (options.documentStatus) {
    await save(setDocumentGenerationStatusOnMessage(conversation, assistantId, options.documentStatus, t0));
  }
  const executions = new JsonConversationResponseExecutionRepository(storage, projectId);
  await executions.create(createConversationResponseExecution({
    id: executionId, projectId, providerInvocationAttemptId: toProviderInvocationAttemptId('attempt-local-recover'), createdAt: t0,
    snapshot: {
      schemaVersion: 1, responseDraftId: toConversationResponseDraftId('draft-local-recover'), responseDraftRevision: 1,
      conversationId, conversationRevision: conversation.revision,
      userMessageId: options.mismatchedResponseSource ? toMessageId('unrelated-source') : sourceId,
      userMessageRevision: 1, assistantMessageId: assistantId,
      productFeature: 'text_chat', routeSnapshotId: toProviderExecutionRouteSnapshotId('route-local-recover'),
      candidate: { schemaVersion: 1, providerId: toProviderId('provider-local-recover'), connectionId: toConnectionId('connection-local-recover'),
        connectionRevision: 1, modelId: toModelId('model-local-recover'), modelRevision: 1, profileId: 'profile-local-recover', profileRevision: 1,
        protocolBindingId: toProtocolBindingId('binding-local-recover'), protocolBindingRevision: 1, runtimeSource: 'official_direct' },
      outboundUserTextSnapshot: '做一份 Word 和 PPT', contextSnapshots: []
    }
  }), createConversationResponseStreamEvent({ id: toConversationResponseStreamEventId('event-local-created'), responseExecutionId: executionId,
    sequence: 1, type: 'execution_created', occurredAt: t0 }));
  if (options.responseState !== 'pending') await executions.appendEvents([
    createConversationResponseStreamEvent({ id: toConversationResponseStreamEventId('event-local-started'), responseExecutionId: executionId,
      sequence: 2, type: 'stream_started', occurredAt: t0 }),
    createConversationResponseStreamEvent({ id: toConversationResponseStreamEventId('event-local-content'), responseExecutionId: executionId,
      sequence: 3, type: 'content_delta', contentDelta: content, occurredAt: t0 })
  ]);
  if (options.responseState !== 'streaming' && options.responseState !== 'pending') {
    await executions.appendEvent(createConversationResponseStreamEvent({
      id: toConversationResponseStreamEventId('event-local-terminal'), responseExecutionId: executionId, sequence: 4,
      ...(options.responseState === 'interrupted'
        ? { type: 'stream_interrupted', interruptionReason: 'application_shutdown' }
        : { type: 'stream_completed' }), occurredAt: t0
    }));
  }
  const workflows = new ConversationWorkflowService(new JsonConversationWorkflowRepository(storage, projectId), new ConversationIntentOrchestrator());
  const workflow = await workflows.create({ projectId, conversationId, sourceMessageId: sourceId, rawText: '做一份 Word 和 PPT' });
  await workflows.beginExecution({ workflowId: workflow.id, expectedRevision: workflow.revision, executionId: 'response-previous-word' });
  const next = await workflows.finishDocumentExecution('response-previous-word', 'completed', { messageId: previousAssistantId, workId: previousWorkId });
  await workflows.beginExecution({ workflowId: workflow.id, expectedRevision: next!.revision, executionId });
  const originalInput = { conversationId, messageId: assistantId, expectedRevision: conversation.revision, kind: 'ppt' as const,
    theme: 'forest' as const, presentationTemplate: 'technology' as const,
    images: [{ workId: 'paid-illustration', caption: '保留的已付费配图' }] };
  if (options.storedInputs !== 'missing') {
    await new ConversationDocumentInputStore(storage, options.storedInputs === 'invalid' ? toProjectId('wrong-project') : projectId)
      .resolve(originalInput, false);
  }
  const runtime = createChatContextRuntime({ userDataDirectory: userData,
    getSession: () => ({ projectId, projectName: '恢复本地文档', rootDirectory: projectRoot }) });
  return { runtime, projectRoot, projectId, storage, conversationId, assistantId, sourceId, executionId, conversations, executions,
    workflows, workflow, originalInput, previousAssistantId, previousWorkId };
}

describe('chat-context composition runtime', () => {
  async function prepareRoot(fixture: Awaited<ReturnType<typeof createLocalDocumentRecoveryFixture>>, now: () => number) {
    const at = () => new Date(now()).toISOString();
    const sessions = new JsonConversationAgentSessionRepository(fixture.storage, fixture.projectId, at);
    const runs = new JsonConversationAgentRunRepository(fixture.storage, fixture.projectId, at);
    const root = createConversationAgentRun({ id: toConversationAgentRunId('production-recovery-root'), projectId: fixture.projectId,
      conversationId: fixture.conversationId, sourceMessageId: fixture.sourceId, createdAt: toIsoTimestamp(at()) });
    await runs.create(root);
    const source = { kind: 'message' as const, id: fixture.sourceId, version: 0, contentHash: 'a'.repeat(64) };
    const service = new ConversationAgentSessionService({ repository: sessions, ownerId: 'other-live-host', now, leaseTtlMs: 1000,
      hash: value => createHash('sha256').update(value).digest('hex'), nextResumeToken: () => 'production-recovery-resume-token',
      recheckContinuation: async () => undefined });
    await service.open({ run: root, budget: { startedAt: now(), deadlineAt: now() + 360_000, maxToolCalls: 8, budgetUnits: 24 }, inputReferences: [source] });
    const preparedChild = createConversationAgentRun({ id: toConversationAgentRunId('production-recovery-child'),
      projectId: fixture.projectId, conversationId: fixture.conversationId, sourceMessageId: fixture.sourceId, parentRunId: root.id,
      createdAt: toIsoTimestamp(at()) });
    await runs.create(preparedChild);
    const child = attachConversationAgentRunExecution(preparedChild, fixture.executionId, toIsoTimestamp(at()));
    await runs.save(child, preparedChild.revision);
    await service.admitInitialSegment({ sessionId: root.id, run: child, inputReference: source });
    await service.bindExecution(child.id, fixture.executionId);
    return { sessions, runs, service, root, child };
  }

  it('does not interrupt or settle a response, workflow or child held by another live root owner', async () => {
    const fixture = await createLocalDocumentRecoveryFixture({ responseState: 'streaming', assistantCompleted: false });
    const clock = Date.now(), root = await prepareRoot(fixture, () => clock);
    try {
      const before = await root.sessions.get(root.root.id), workflow = await fixture.workflows.get(fixture.workflow.id);
      const child = await root.runs.get(root.child.id);
      const result = await fixture.runtime.conversations.get({ conversationId: fixture.conversationId });
      expect(result).toMatchObject({ ok: true, value: { messages: expect.arrayContaining([
        expect.objectContaining({ messageId: fixture.assistantId, state: 'streaming' })
      ]) } });
      expect((await fixture.executions.get(fixture.executionId))?.state).toBe('streaming');
      expect(await fixture.workflows.get(fixture.workflow.id)).toEqual(workflow);
      expect(await root.runs.get(root.child.id)).toEqual(child);
      expect(await root.sessions.get(root.root.id)).toEqual(before);
      await fixture.runtime.waitForMutations();
    } finally { root.service.dispose(); }
  });

  it('rejects another live host explicit reconciliation and acknowledgement before writing any prepared child WAL', async () => {
    const fixture = await createLocalDocumentRecoveryFixture({ responseState: 'streaming', assistantCompleted: false });
    const clock = Date.now(), root = await prepareRoot(fixture, () => clock);
    try {
      const child = markConversationAgentRunNeedsReconciliation(root.child, 'unknown_result', root.child.updatedAt);
      await root.runs.save(child, root.child.revision);
      const before = await root.sessions.get(root.root.id);
      const runtime = createChatContextRuntime({ userDataDirectory: path.join(fixture.projectRoot, 'test-foreign-reconcile-user'), executionNow: () => clock,
        getSession: () => ({ projectId: fixture.projectId, projectName: '外部所有者测试', rootDirectory: fixture.projectRoot }) });
      const query = { projectId: fixture.projectId, responseExecutionId: fixture.executionId };
      const inspected = await runtime.responses.inspectReconciliation(query);
      expect(inspected.ok).toBe(true);
      if (!inspected.ok) throw new Error(inspected.error.code);
      expect(await runtime.responses.reconcileReconciliation(query)).toMatchObject({ ok: false, error: { code: 'continuation_conflict' } });
      expect(await runtime.responses.acknowledgeReconciliation({ ...query, expectedRunRevision: child.revision,
        inspectToken: inspected.value.inspectToken, confirmed: true })).toMatchObject({ ok: false, error: { code: 'continuation_conflict' } });
      expect(await new JsonConversationCompletionJournal(fixture.storage, fixture.projectId).get(fixture.executionId)).toBeUndefined();
      expect(await root.runs.get(child.id)).toEqual(child); expect(await root.sessions.get(root.root.id)).toEqual(before);
      expect((await fixture.executions.get(fixture.executionId))?.state).toBe('streaming');
      await runtime.waitForMutations();
    } finally { root.service.dispose(); }
  });

  it('retires a proven unsubmitted response locally and keeps the original root waiting for explicit continuation', async () => {
    const fixture = await createLocalDocumentRecoveryFixture({ responseState: 'pending', assistantCompleted: false });
    let clock = Date.now();
    const root = await prepareRoot(fixture, () => clock);
    root.service.dispose(); clock += 1500;
    const runtime = createChatContextRuntime({ userDataDirectory: path.join(fixture.projectRoot, 'test-second-user'), executionNow: () => clock,
      getSession: () => ({ projectId: fixture.projectId, projectName: '续接测试', rootDirectory: fixture.projectRoot }) });
    const result = await runtime.conversations.get({ conversationId: fixture.conversationId });
    expect(result).toMatchObject({ ok: true, value: { agentSessions: [expect.objectContaining({ state: 'waiting_user',
      waiting: { reason: 'continuation_required', allowedActions: ['continue'] }, resumeToken: expect.any(String) })] } });
    expect((await fixture.executions.get(fixture.executionId))?.state).toBe('failed');
    expect((await root.runs.get(root.child.id))?.status).toBe('failed');
    const saved = (await root.sessions.get(root.root.id))!;
    expect(saved.status).toBe('waiting_user');
    expect(saved.budget).toMatchObject({ deadlineAt: clock - 1500 + 360_000, toolCallsUsed: 0, costUnitsUsed: 0 });
    expect(saved.childSegments).toHaveLength(2);
    expect((await new JsonConversationCompletionJournal(fixture.storage, fixture.projectId).get(fixture.executionId))?.stage).toBe('applied');
    expect((await fixture.executions.listEvents(fixture.executionId)).map(event => event.type)).toEqual(['execution_created', 'stream_failed']);
    await runtime.waitForMutations();
  });

  it('freezes prior streaming evidence even if its canonical model WAL is missing', async () => {
    const fixture = await createLocalDocumentRecoveryFixture({ responseState: 'streaming', assistantCompleted: false });
    let clock = Date.now();
    const root = await prepareRoot(fixture, () => clock);
    root.service.dispose(); clock += 1500;
    const runtime = createChatContextRuntime({ userDataDirectory: path.join(fixture.projectRoot, 'test-missing-wal-user'), executionNow: () => clock,
      getSession: () => ({ projectId: fixture.projectId, projectName: '缺失边界测试', rootDirectory: fixture.projectRoot }) });
    const result = await runtime.conversations.get({ conversationId: fixture.conversationId });
    expect(result).toMatchObject({ ok: true,
      value: { agentSessions: [expect.objectContaining({ state: 'needs_reconciliation' })] } });
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.agentSessions?.[0]).not.toHaveProperty('resumeToken');
    expect((await root.sessions.get(root.root.id))?.status).toBe('needs_reconciliation');
    expect((await root.runs.get(root.child.id))?.status).toBe('needs_reconciliation');
    expect((await fixture.executions.listEvents(fixture.executionId)).filter(event => event.safeCode === 'conversation.recovery_prepared_not_submitted')).toEqual([]);
    await runtime.waitForMutations();
  });

  it.each(['validating_outline', 'generating_file', 'interrupted'] as const)(
    'recovers completed provider text during %s as a local Office retry while preserving delivered work', async (state) => {
      const fixture = await createLocalDocumentRecoveryFixture({ documentStatus: { state, kind: 'ppt' } });
      const { runtime, conversationId, assistantId, executionId, workflows, workflow, executions } = fixture;
      const [conversation, pending] = await Promise.all([
        runtime.conversations.get({ conversationId }), runtime.workflows.getPending({ conversationId })
      ]);
      expect(conversation).toMatchObject({ ok: true, value: { messages: expect.arrayContaining([
        expect.objectContaining({ messageId: assistantId, state: 'completed', documentGenerationStatus: { state: 'interrupted', kind: 'ppt' } }),
        expect.objectContaining({ messageId: fixture.previousAssistantId, documentResult: expect.objectContaining({ workId: fixture.previousWorkId }) })
      ]) } });
      expect(pending).toMatchObject({ ok: true, value: { status: 'failed', deliveries: [
        expect.objectContaining({ kind: 'word', status: 'completed', workId: fixture.previousWorkId }),
        expect.objectContaining({ kind: 'ppt', status: 'failed', failureReason: 'execution_failed', resultMessageId: assistantId, executionId })
      ] } });
      const failed = await workflows.get(workflow.id);
      const resumed = await runtime.workflows.resumeFailed({ workflowId: workflow.id, expectedRevision: failed!.revision });
      expect(resumed).toMatchObject({ ok: true, value: { status: 'executing', executionId, deliveries: [
        expect.objectContaining({ kind: 'word', status: 'completed', workId: fixture.previousWorkId }),
        expect.objectContaining({ kind: 'ppt', status: 'executing', resultMessageId: assistantId, executionId })
      ] } });
      const recovered = (await fixture.conversations.get(conversationId))!;
      const reuse = recovered.messages.find((message) => message.id === assistantId)?.documentGenerationStatus?.state === 'interrupted';
      const inputs = new ConversationDocumentInputStore(new NodeProjectStorage(fixture.projectRoot), fixture.projectId);
      expect(await inputs.resolve({ ...fixture.originalInput, expectedRevision: recovered.revision, theme: 'ink', images: [] }, reuse))
        .toEqual({ ...fixture.originalInput, expectedRevision: recovered.revision });
      expect(await executions.list()).toHaveLength(1);
      expect((await executions.get(executionId))?.state).toBe('completed');
      expect((await executions.listEvents(executionId)).map((event) => event.type))
        .toEqual(['execution_created', 'stream_started', 'content_delta', 'stream_completed']);
      await runtime.waitForMutations();
    }
  );

  it.each([
    { label: 'active provider response', responseState: 'streaming', documentStatus: { state: 'generating_file', kind: 'ppt' } },
    { label: 'unknown provider outcome', responseState: 'interrupted', documentStatus: { state: 'generating_file', kind: 'ppt' } },
    { label: 'unfinished assistant message', assistantCompleted: false, documentStatus: { state: 'generating_file', kind: 'ppt' } },
    { label: 'another source message', mismatchedResponseSource: true, documentStatus: { state: 'generating_file', kind: 'ppt' } },
    { label: 'no local generation state' },
    { label: 'content preparation only', documentStatus: { state: 'generating_content', kind: 'ppt' } },
    { label: 'another document format', documentStatus: { state: 'generating_file', kind: 'word' } }
  ] as const)('keeps $label blocked from automatic Office retry', async (options) => {
    const fixture = await createLocalDocumentRecoveryFixture(options);
    await fixture.runtime.workflows.getPending({ conversationId: fixture.conversationId });
    const failed = (await fixture.workflows.get(fixture.workflow.id))!;
    expect(failed.deliveries?.[1]).toMatchObject({ status: 'failed', failureReason: 'interrupted' });
    expect(await fixture.runtime.workflows.resumeFailed({ workflowId: failed.id, expectedRevision: failed.revision }))
      .toMatchObject({ ok: false, error: { code: 'workflow_not_ready' } });
    await fixture.runtime.waitForMutations();
  });

  it.each(['missing', 'invalid'] as const)('does not replace %s original render inputs with retry defaults', async (storedInputs) => {
    const fixture = await createLocalDocumentRecoveryFixture({ documentStatus: { state: 'generating_file', kind: 'ppt' }, storedInputs });
    await fixture.runtime.workflows.getPending({ conversationId: fixture.conversationId });
    const failed = (await fixture.workflows.get(fixture.workflow.id))!;
    expect(await fixture.runtime.workflows.resumeFailed({ workflowId: failed.id, expectedRevision: failed.revision }))
      .toMatchObject({ ok: true, value: { status: 'executing' } });
    const conversation = (await fixture.conversations.get(fixture.conversationId))!;
    const message = conversation.messages.find((item) => item.id === fixture.assistantId)!;
    const inputs = new ConversationDocumentInputStore(new NodeProjectStorage(fixture.projectRoot), fixture.projectId);
    await expect(inputs.resolve({ ...fixture.originalInput, expectedRevision: conversation.revision, theme: 'ink', images: [] },
      message.documentGenerationStatus?.state === 'interrupted')).rejects.toThrow(
      storedInputs === 'missing' ? '原文档生成参数已缺失' : 'another project');
    expect((await fixture.executions.listEvents(fixture.executionId))).toHaveLength(4);
    await fixture.runtime.waitForMutations();
  });

  it('recovers a persisted pending response before exposing the conversation or Office retry state', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'unicomp-recover-project-'));
    const userData = await mkdtemp(path.join(os.tmpdir(), 'unicomp-recover-user-'));
    roots.push(projectRoot, userData);
    const projectId = toProjectId('project-recover');
    const conversationId = toConversationId('conversation-recover');
    const sourceId = toMessageId('source-recover');
    const assistantId = toMessageId('assistant-recover');
    const executionId = toConversationResponseExecutionId('response-recover');
    const t0 = toIsoTimestamp('2026-09-09T00:00:00.000Z');
    const storage = new NodeProjectStorage(projectRoot);
    const conversations = new JsonProjectConversationRepository(storage, projectId);
    const emptyConversation = createConversation({
      id: conversationId, projectId, title: '恢复测试', createdAt: t0
    });
    await conversations.create(emptyConversation);
    const withUser = addUserMessage(emptyConversation, { id: sourceId, content: '做一份 Word 和 PPT', createdAt: t0 });
    await conversations.save(withUser, emptyConversation.revision);
    await conversations.save(beginAssistantMessage(withUser, { id: assistantId, createdAt: t0 }), withUser.revision);
    const executions = new JsonConversationResponseExecutionRepository(storage, projectId);
    await executions.create(createConversationResponseExecution({
      id: executionId, projectId, providerInvocationAttemptId: toProviderInvocationAttemptId('attempt-recover'), createdAt: t0,
      snapshot: {
        schemaVersion: 1, responseDraftId: toConversationResponseDraftId('draft-recover'), responseDraftRevision: 1,
        conversationId, conversationRevision: 2, userMessageId: sourceId, userMessageRevision: 1, assistantMessageId: assistantId,
        productFeature: 'text_chat', routeSnapshotId: toProviderExecutionRouteSnapshotId('route-recover'),
        candidate: { schemaVersion: 1, providerId: toProviderId('provider-recover'), connectionId: toConnectionId('connection-recover'),
          connectionRevision: 1, modelId: toModelId('model-recover'), modelRevision: 1, profileId: 'profile-recover', profileRevision: 1,
          protocolBindingId: toProtocolBindingId('binding-recover'), protocolBindingRevision: 1, runtimeSource: 'official_direct' },
        outboundUserTextSnapshot: '做一份 Word 和 PPT', contextSnapshots: []
      }
    }), createConversationResponseStreamEvent({ id: toConversationResponseStreamEventId('event-recover'), responseExecutionId: executionId,
      sequence: 1, type: 'execution_created', occurredAt: t0 }));
    const workflows = new ConversationWorkflowService(new JsonConversationWorkflowRepository(storage, projectId), new ConversationIntentOrchestrator());
    const workflow = await workflows.create({ projectId, conversationId, sourceMessageId: sourceId, rawText: '做一份 Word 和 PPT' });
    await workflows.beginExecution({ workflowId: workflow.id, expectedRevision: workflow.revision, executionId });
    const runtime = createChatContextRuntime({ userDataDirectory: userData,
      getSession: () => ({ projectId, projectName: '恢复测试', rootDirectory: projectRoot }) });
    const [conversation, pending] = await Promise.all([
      runtime.conversations.get({ conversationId }), runtime.workflows.getPending({ conversationId })
    ]);
    expect(conversation).toMatchObject({ ok: true, value: { messages: expect.arrayContaining([
      expect.objectContaining({ messageId: assistantId, state: 'failed', failureReason: 'interrupted' })
    ]) } });
    expect(pending).toMatchObject({ ok: true, value: { status: 'failed', deliveries: expect.arrayContaining([
      expect.objectContaining({ status: 'failed', failureReason: 'interrupted' })
    ]) } });
    expect((await executions.get(executionId))?.state).toBe('interrupted');
    expect((await executions.listEvents(executionId)).filter((event) => event.type === 'stream_interrupted')).toHaveLength(1);
    const failed = await workflows.get(workflow.id);
    await expect(workflows.resumeFailedDelivery({ workflowId: workflow.id, expectedRevision: failed!.revision })).rejects.toThrow();
    await runtime.waitForMutations();
  });

  it('keeps new conversations, response drafts and contexts project-scoped', async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), 'unicomp-runtime-user-'));
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'unicomp-runtime-project-'));
    roots.push(userData, projectRoot);
    const session: StorageProjectSession = {
      projectId: toProjectId('project-runtime'),
      projectName: 'Runtime project',
      rootDirectory: projectRoot
    };
    const runtime = createChatContextRuntime({
      userDataDirectory: userData,
      getSession: () => session,
      conversationIds: {
        nextConversationId: () => toConversationId('conversation-runtime'),
        nextMessageId: () => toMessageId('message-runtime')
      },
      projectContextIds: {
        nextDraftId: () => toProjectContextDraftId('draft-runtime'),
        nextFragmentId: () => toProjectContextFragmentId('fragment-runtime'),
        nextContextId: () => toProjectContextId('context-runtime')
      }
    });
    const created = await runtime.conversations.create({
      title: 'Runtime chat',
      bindToCurrentProject: true
    });
    if (!created.ok) throw new Error('conversation creation failed');
    const messaged = await runtime.conversations.addUserMessage({
      conversationId: created.value.conversationId,
      expectedRevision: created.value.revision,
      content: 'runtime selected content'
    });
    if (!messaged.ok) throw new Error('message creation failed');
    const draft = await runtime.projectContexts.createDraft({
      conversationId: created.value.conversationId
    });
    if (!draft.ok) throw new Error('draft creation failed');
    const fragment = await runtime.projectContexts.addMessageFragment({
      draftId: draft.value.draftId,
      expectedRevision: draft.value.revision,
      messageId: messaged.value.messages[0].messageId,
      startUtf16: 0,
      endUtf16: messaged.value.messages[0].content.length
    });
    if (!fragment.ok) throw new Error('fragment creation failed');
    await runtime.waitForMutations();

    const conversationDocument = JSON.parse(
      await readFile(path.join(projectRoot, 'entities', 'conversations.json'), 'utf8')
    );
    const contextDocument = JSON.parse(
      await readFile(
        path.join(projectRoot, 'entities', 'project-contexts.json'),
        'utf8'
      )
    );
    expect(conversationDocument.conversations).toHaveLength(1);
    expect(contextDocument.drafts).toHaveLength(1);
    expect(JSON.stringify(fragment)).not.toContain(userData);
    expect(JSON.stringify(fragment)).not.toContain(projectRoot);
  });
});
