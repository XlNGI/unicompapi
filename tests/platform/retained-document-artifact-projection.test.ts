import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addUserMessage, attachRetainedDocumentResultToMessage, beginAssistantMessage, createProjectConversation,
  createConversationResponseExecution, createConversationResponseStreamEvent, failAssistantMessage,
  createConversationAgentRun, attachConversationAgentRunExecution, bindConversationAgentRunTasks,
  transitionConversationAgentRun, toConversationAgentRunId,
  toConnectionId, toConversationId, toConversationResponseDraftId, toConversationResponseExecutionId,
  toConversationResponseStreamEventId, toIsoTimestamp, toMessageId, toModelId, toProjectId,
  toProtocolBindingId, toProviderExecutionRouteSnapshotId, toProviderId, toProviderInvocationAttemptId
} from '../../src/domain';
import { DocumentGenerationRunner } from '../../src/platform/documents/document-generation-runner';
import { PlatformDocumentDraftCompiler, PlatformDocumentGenerationExecutor } from '../../src/platform/documents/document-generation-application-adapters';
import { ConversationDocumentToolSessionService } from '../../src/platform/documents/conversation-document-tool-session';
import { readPptxDocument } from '../../src/platform/documents/pptx-page-reader';
import { JsonProjectConversationRepository } from '../../src/platform/repositories/json-project-conversation-repository';
import { JsonConversationResponseExecutionRepository } from '../../src/platform/repositories/json-conversation-response-execution-repository';
import { JsonFileReferenceRepository, JsonWorkRepository } from '../../src/platform/repositories/json-repositories';
import { NodeProjectStorage } from '../../src/platform/storage';
import { toConversationDto } from '../../src/platform/ipc/conversation-controller';
import { verifyRetainedDocumentArtifacts } from '../../src/platform/ipc/retained-document-artifact-projection';
import { JsonConversationAgentRunRepository } from '../../src/platform/repositories/json-conversation-agent-run-repository';
import { JsonConversationCompletionJournal } from '../../src/platform/repositories/json-conversation-completion-journal';
import { JsonDocumentTaskRuntimeRepository } from '../../src/platform/repositories/json-document-task-runtime-repository';
import { createChatContextRuntime } from '../../src/platform/ipc/chat-context-runtime';

const roots: string[] = [];
const now = toIsoTimestamp('2026-10-04T12:00:00.000Z');
const projectId = toProjectId('isolated-retained-project');
afterEach(async () => {
  for (const root of roots.splice(0)) {
    expect(path.dirname(path.resolve(root))).toBe(path.resolve(os.tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

async function fixture() {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'unicomp-retained-projection-'));
  roots.push(rootDirectory);
  const storage = new NodeProjectStorage(rootDirectory);
  const conversations = new JsonProjectConversationRepository(storage, projectId, () => now);
  const works = new JsonWorkRepository(storage, projectId);
  const files = new JsonFileReferenceRepository(storage, projectId);
  const executionId = toConversationResponseExecutionId('retained-response');
  const assistantId = toMessageId('retained-assistant');
  const userId = toMessageId('retained-user');
  let conversation = createProjectConversation({ id: toConversationId('retained-conversation'), projectId,
    title: '离线保留作品验证', createdAt: now });
  await conversations.create(conversation);
  conversation = addUserMessage(conversation, { id: userId, content: '直接生成一份测试PPT。', createdAt: now });
  await conversations.save(conversation, 0);
  const service = new ConversationDocumentToolSessionService({ rootDirectory, projectId, conversations,
    getCurrentProjectId: () => projectId, generatePptx: { compiler: new PlatformDocumentDraftCompiler(),
      executor: new PlatformDocumentGenerationExecutor(new DocumentGenerationRunner({ rootDirectory, projectId,
        requireRenderForPpt: true, renderPreview: async target => ({ previewCount: (await readPptxDocument(await readFile(target))).length, diagnostics: [] }) })),
      revalidateAuthorization: async () => true } });
  const selected = await service.select({ conversation, currentUserMessageId: userId, query: conversation.messages[0].content });
  if (!selected) throw new Error('Missing synthetic generation selection');
  const session = await service.createSession({ selection: selected, responseExecutionId: executionId });
  const signal = new AbortController().signal;
  try {
    await session.prepareTools(signal);
    expect(await session.bridge.execute({ call: { id: 'retained-generate', name: 'generate_pptx', arguments: {
      title: '离线保留作品', content: '# 离线保留作品\n\n## 第一部分\n\n真实文件内容。\n\n## 第二部分\n\n用于Hash和页数检查。',
      presentationTemplate: 'business_minimal' } }, signal })).toMatchObject({ status: 'success' });
  } finally { await session.close(); await service.dispose(); }
  const work = (await works.list(projectId))[0];
  const file = (await files.get(work.fileId))!;
  if (file.locator.kind !== 'project') throw new Error('Expected local generated file');
  const absolutePath = path.join(rootDirectory, file.locator.relativePath);
  const actualPageCount = (await readPptxDocument(await readFile(absolutePath))).length;
  const pending = beginAssistantMessage(conversation, { id: assistantId, createdAt: now });
  await conversations.save(pending, conversation.revision);
  const stopped = failAssistantMessage(pending, assistantId, 'unknown', now);
  await conversations.save(stopped, pending.revision);
  conversation = attachRetainedDocumentResultToMessage(stopped, assistantId,
    { workId: work.id, fileName: path.basename(absolutePath), kind: 'ppt', sizeBytes: file.sizeBytes!, actualPageCount }, now);
  const execution = createConversationResponseExecution({ id: executionId, projectId,
    providerInvocationAttemptId: toProviderInvocationAttemptId('isolated-attempt'), createdAt: now, snapshot: {
      schemaVersion: 1, responseDraftId: toConversationResponseDraftId('isolated-draft'), responseDraftRevision: 1,
      conversationId: conversation.id, conversationRevision: 1, userMessageId: userId, userMessageRevision: 0,
      assistantMessageId: assistantId, productFeature: 'text_chat', routeSnapshotId: toProviderExecutionRouteSnapshotId('isolated-route'),
      candidate: { schemaVersion: 1, providerId: toProviderId('isolated-provider'), connectionId: toConnectionId('isolated-connection'),
        connectionRevision: 1, modelId: toModelId('isolated-model'), modelRevision: 1, profileId: 'isolated-profile', profileRevision: 1,
        protocolBindingId: toProtocolBindingId('isolated-binding'), protocolBindingRevision: 1, runtimeSource: 'newapi_gateway' },
      outboundUserTextSnapshot: '离线测试夹具；无Provider请求。', contextSnapshots: []
    } });
  const responses = new JsonConversationResponseExecutionRepository(storage, projectId);
  await responses.create(execution, createConversationResponseStreamEvent({ id: toConversationResponseStreamEventId('retained-event-1'),
    responseExecutionId: executionId, sequence: 1, type: 'execution_created', occurredAt: now }));
  await responses.appendEvent(createConversationResponseStreamEvent({ id: toConversationResponseStreamEventId('retained-event-2'),
    responseExecutionId: executionId, sequence: 2, type: 'stream_failed', safeCode: 'newapi.tool_loop_unknown_result', occurredAt: now }));
  let current = true;
  const scope = { rootDirectory, projectId, isCurrent: () => current };
  const dto = { ...toConversationDto(conversation), parentRuns: [{ responseExecutionId: executionId, sourceMessageId: userId,
    state: 'needs_reconciliation' as const, reconciliationReason: 'unknown_result' as const, runRevision: 2,
    registeredWorkCount: 1, acknowledged: false }] };
  return { dto, scope, file, files, work, works, absolutePath, storage, conversations, executionId,
    revokeProject: () => { current = false; } };
}

describe('current retained artifact capability', () => {
  it('reads actual PPT bytes and keeps an independently known file while the response remains unknown', async () => {
    const data = await fixture();
    expect(await verifyRetainedDocumentArtifacts(data.dto, data.scope)).toEqual(data.dto);
    expect(await verifyRetainedDocumentArtifacts(data.dto, data.scope)).toEqual(data.dto);
    expect(data.dto.messages[1]).toMatchObject({ state: 'failed', failureReason: 'unknown' });
    expect(data.dto.parentRuns[0].state).toBe('needs_reconciliation');
    expect(await data.works.list(projectId)).toHaveLength(1);
  });
  it.each(['metadata', 'bytes', 'project', 'wrong_goal'] as const)('withholds a stale card after %s changes without mutating the receipt or regenerating', async reason => {
    const data = await fixture();
    const original = JSON.stringify(data.dto);
    if (reason === 'metadata') await data.files.save({ ...data.file, state: 'missing' });
    if (reason === 'bytes') await writeFile(data.absolutePath, Buffer.from('changed local file'));
    if (reason === 'project') data.revokeProject();
    const dto = reason === 'wrong_goal' ? { ...data.dto, messages: data.dto.messages.map(message => message.retainedDocumentResult
      ? { ...message, retainedDocumentResult: { ...message.retainedDocumentResult, planningTargetTotalPages: 12 } } : message) } : data.dto;
    const projected = await verifyRetainedDocumentArtifacts(dto, data.scope);
    expect(projected.messages[1].retainedDocumentResult).toBeUndefined();
    expect(JSON.stringify(data.dto)).toBe(original);
    expect(projected.messages[1].state).toBe('failed');
    expect(projected.parentRuns?.[0].state).toBe('needs_reconciliation');
    expect(await data.works.list(projectId)).toHaveLength(1);
  });

  it.each(['valid', 'metadata', 'bytes'] as const)('reopens an already applied failed parent with %s bytes using only verified local projection', async condition => {
    const data = await fixture();
    const tasks = await new JsonDocumentTaskRuntimeRepository(data.storage, projectId).list();
    const runs = new JsonConversationAgentRunRepository(data.storage, projectId, () => now);
    const journal = new JsonConversationCompletionJournal(data.storage, projectId, () => now);
    let run = createConversationAgentRun({ id: toConversationAgentRunId('retained-failed-run'), projectId,
      conversationId: toConversationId(data.dto.conversationId), sourceMessageId: toMessageId('retained-user'), createdAt: now });
    await runs.create(run);
    let updated = attachConversationAgentRunExecution(run, data.executionId, now);
    await runs.save(updated, run.revision); run = updated;
    updated = bindConversationAgentRunTasks(run, tasks.map(task => task.id), now);
    await runs.save(updated, run.revision); run = updated;
    updated = transitionConversationAgentRun(run, 'failed', now);
    await runs.save(updated, run.revision); run = updated;
    await journal.save({ schemaVersion: 1, revision: 0, responseExecutionId: data.executionId, expectedRunRevision: run.revision,
      targetRun: run, decision: { status: 'failed', reason: 'response_failed', registeredWorkIds: [data.work.id], executionOwner: 'none',
        canReplay: false, responseCompleted: false, documentCompleted: true }, responseState: 'failed',
      taskRevisions: tasks.map(task => ({ id: task.id, revision: task.revision })), stage: 'applied', createdAt: now, updatedAt: now }, null);
    const originalJournal = await journal.get(data.executionId);
    if (condition === 'metadata') await data.files.save({ ...data.file, state: 'missing' });
    if (condition === 'bytes') await writeFile(data.absolutePath, Buffer.from('changed before reopening'));
    let firstRevision: number | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const errors: unknown[] = [];
      const reopened = createChatContextRuntime({ userDataDirectory: path.join(data.scope.rootDirectory, 'isolated-profile'),
        getSession: () => ({ projectId, projectName: '离线重开夹具', rootDirectory: data.scope.rootDirectory }),
        now: () => now, onError: error => errors.push(error) });
      const result = await reopened.conversations.get({ conversationId: data.dto.conversationId });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.code);
      const assistant = result.value.messages.find(message => message.messageId === 'retained-assistant');
      expect(assistant?.state).toBe('failed');
      if (condition === 'valid') {
        expect(assistant?.retainedDocumentResult).toMatchObject(data.dto.messages[1].retainedDocumentResult!);
        expect(assistant?.retainedDocumentResult).not.toHaveProperty('planningTargetTotalPages');
      } else expect(assistant?.retainedDocumentResult).toBeUndefined();
      if (attempt === 0) firstRevision = assistant!.revision;
      else expect(assistant?.revision).toBe(firstRevision);
      await reopened.waitForMutations();
      expect(errors).toEqual([]);
      expect(await journal.get(data.executionId)).toEqual(originalJournal);
      expect(await runs.get(run.id)).toEqual(run);
      expect(await data.works.list(projectId)).toHaveLength(1);
    }
  });
});
