import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationIntentOrchestrator, ConversationWorkflowService } from '../../src/application';
import { createDocumentWorkflowSettlement } from '../../src/platform/documents/conversation-document-workflow';
import { JsonConversationWorkflowRepository } from '../../src/platform/repositories';
import { NodeProjectStorage } from '../../src/platform/storage';
import { toConversationId, toMessageId, toProjectId, toWorkId, type ProjectConversationRepository, type ConversationResponseExecutionRepository } from '../../src/domain';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('Office workflow settlement', () => {
  async function fixture(local = false) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-document-settle-'));
    roots.push(root);
    const projectId = toProjectId('project-settle');
    const conversationId = toConversationId('conversation-settle');
    const messageId = toMessageId('assistant-settle');
    const workId = toWorkId('work-settle');
    const service = new ConversationWorkflowService(new JsonConversationWorkflowRepository(new NodeProjectStorage(root), projectId), new ConversationIntentOrchestrator());
    const workflow = await service.create({ projectId, conversationId, sourceMessageId: toMessageId('source-settle'), rawText: '帮我做一份 Word 和一份 PPT' });
    const executionId = local ? 'local-document-revision-settle' : 'response-settle';
    const started = await service.beginExecution({ workflowId: workflow.id, expectedRevision: workflow.revision, executionId });
    const kind = started.plan.documentKind as 'word' | 'ppt';
    let registered = false;
    const conversations = { projectId, get: async () => ({ projectId, id: conversationId, messages: [{ id: messageId, role: 'assistant', state: 'completed',
      ...(registered ? { documentResult: { workId, kind, validatedContent: '{"sections":[]}' } } : {}) }] }) } as unknown as ProjectConversationRepository;
    const executions = { list: async () => local ? [] : [{ id: executionId, snapshot: { assistantMessageId: messageId } }] } as unknown as ConversationResponseExecutionRepository;
    return { service, started, conversationId, messageId, workId, kind, register: () => { registered = true; },
      settle: createDocumentWorkflowSettlement({ workflows: service, conversations, executions }) };
  }

  it('does not advance on model completion, then advances exactly once after a persisted Work', async () => {
    const f = await fixture();
    await f.service.finishExecution('response-settle', 'completed');
    expect((await f.service.get(f.started.id))?.status).toBe('executing');
    await expect(f.settle({ conversationId: f.conversationId, messageId: f.messageId, kind: f.kind, status: 'completed', workId: f.workId }))
      .rejects.toThrow('persisted validated Work');
    f.register();
    await f.settle({ conversationId: f.conversationId, messageId: f.messageId, kind: f.kind, status: 'completed', workId: f.workId });
    const completed = await f.service.get(f.started.id);
    expect(completed).toMatchObject({ status: 'ready', deliveries: expect.arrayContaining([
      expect.objectContaining({ kind: f.kind, status: 'completed', workId: f.workId, resultMessageId: f.messageId })
    ]) });
    expect(completed?.plan.documentKind).not.toBe(f.kind);
    await f.settle({ conversationId: f.conversationId, messageId: f.messageId, kind: f.kind, status: 'completed', workId: f.workId });
    expect((await f.service.get(f.started.id))?.revision).toBe(completed?.revision);
  });

  it('records known local generation failure separately from unknown provider outcome', async () => {
    const f = await fixture();
    await f.settle({ conversationId: f.conversationId, messageId: f.messageId, kind: f.kind, status: 'failed' });
    const failed = await f.service.get(f.started.id);
    expect(failed).toMatchObject({ status: 'failed', deliveries: expect.arrayContaining([
      expect.objectContaining({ kind: f.kind, failureReason: 'execution_failed' })
    ]) });
    const resumed = await f.service.resumeFailedDelivery({ workflowId: f.started.id, expectedRevision: failed!.revision });
    expect(resumed.status).toBe('executing');
    expect(resumed.plan.documentKind).toBe(f.kind);
    expect(resumed.executionId).toBe(f.started.executionId);
    expect(resumed.deliveries?.find((delivery) => delivery.kind === f.kind)?.resultMessageId).toBe(f.messageId);
    f.register();
    await f.settle({ conversationId: f.conversationId, messageId: f.messageId, kind: f.kind, status: 'completed', workId: f.workId });
    expect((await f.service.get(f.started.id))?.status).toBe('ready');
  });

  it('requires the application-bound local execution identity before settling a local revision', async () => {
    const f = await fixture(true);
    f.register();
    const input = { conversationId: f.conversationId, messageId: f.messageId, kind: f.kind,
      status: 'completed' as const, workId: f.workId };
    await f.settle(input);
    await f.settle({ ...input, localExecutionId: 'local-document-revision-unrelated' });
    expect((await f.service.get(f.started.id))?.status).toBe('executing');
    await f.settle({ ...input, localExecutionId: f.started.executionId });
    expect((await f.service.get(f.started.id))?.status).toBe('ready');
  });
});
