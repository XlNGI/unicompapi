import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addUserMessage,
  beginAssistantMessage,
  createConversation,
  createConversationResponseExecution,
  createConversationResponseStreamEvent,
  toConnectionId,
  toConversationId,
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
  toProviderInvocationAttemptId
} from '../../src/domain';
import { ConversationIntentOrchestrator, ConversationWorkflowService } from '../../src/application';
import { JsonConversationResponseExecutionRepository, JsonConversationWorkflowRepository, JsonProjectConversationRepository } from '../../src/platform/repositories';
import { NodeProjectStorage } from '../../src/platform/storage';
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

describe('chat-context composition runtime', () => {
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
