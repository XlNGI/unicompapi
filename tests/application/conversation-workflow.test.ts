import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConversationIntentOrchestrator,
  ConversationWorkflowService
} from '../../src/application';
import {
  toConversationId,
  toConversationWorkflowId,
  toMessageId,
  toProjectId
} from '../../src/domain';
import {
  ConversationWorkflowRevisionConflictError,
  JsonConversationWorkflowRepository
} from '../../src/platform/repositories';
import { NodeProjectStorage } from '../../src/platform/storage';

const roots: string[] = [];
const projectId = toProjectId('project-workflow-test');
const conversationId = toConversationId('conversation-workflow-test');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Conversation workflow', () => {
  it('persists clarification state and merges a later answer into the same workflow', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-workflow-'));
    roots.push(root);
    let clock = 0;
    const now = () => `2026-09-03T00:00:0${clock++}.000Z`;
    const repository = new JsonConversationWorkflowRepository(
      new NodeProjectStorage(root),
      projectId,
      now
    );
    const service = new ConversationWorkflowService(
      repository,
      new ConversationIntentOrchestrator(),
      now,
      () => toConversationWorkflowId('workflow-summary')
    );
    const created = await service.create({
      projectId,
      conversationId,
      sourceMessageId: toMessageId('message-summary'),
      rawText: '帮我做个总结'
    });
    expect(created.status).toBe('needs_clarification');
    expect(created.pendingQuestions).toHaveLength(1);

    const answered = await service.answer({
      workflowId: created.id,
      expectedRevision: created.revision,
      rawText: 'PPT，8页，面向管理层，简洁一点'
    });
    expect(answered.status).toBe('ready');
    expect(answered.plan).toMatchObject({
      documentKind: 'ppt',
      parameters: {
        pageCount: 8,
        audience: '管理层',
        style: '简洁'
      }
    });
    expect((await repository.get(created.id))?.revision).toBe(1);
  });

  it('recovers an unknown workflow from the previous topic plus a terse PPT answer', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-workflow-natural-language-'));
    roots.push(root);
    let clock = 0;
    const now = () => `2026-09-03T00:00:0${clock++}.000Z`;
    const repository = new JsonConversationWorkflowRepository(
      new NodeProjectStorage(root),
      projectId,
      now
    );
    const service = new ConversationWorkflowService(
      repository,
      new ConversationIntentOrchestrator(),
      now,
      () => toConversationWorkflowId('workflow-natural-language')
    );
    const created = await service.create({
      projectId,
      conversationId,
      sourceMessageId: toMessageId('message-natural-language'),
      rawText: '帮我做一个关于龙的'
    });
    expect(created.status).toBe('needs_clarification');

    const answered = await service.answer({
      workflowId: created.id,
      expectedRevision: created.revision,
      rawText: '制作ppt',
      context: {
        recentUserMessages: ['帮我做一个关于龙的', '制作ppt']
      }
    });
    expect(answered).toMatchObject({
      status: 'ready',
      plan: {
        kind: 'document',
        action: 'create',
        documentKind: 'ppt',
        parameters: { topic: expect.stringContaining('关于龙') }
      }
    });
  });

  it('rejects stale workflow saves atomically', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-workflow-conflict-'));
    roots.push(root);
    const repository = new JsonConversationWorkflowRepository(
      new NodeProjectStorage(root),
      projectId,
      () => '2026-09-03T00:00:00.000Z'
    );
    const service = new ConversationWorkflowService(
      repository,
      new ConversationIntentOrchestrator(),
      () => '2026-09-03T00:00:00.000Z',
      () => toConversationWorkflowId('workflow-conflict')
    );
    const workflow = await service.create({
      projectId,
      conversationId,
      sourceMessageId: toMessageId('message-conflict'),
      rawText: '这个报告出了问题'
    });
    const cancelled = await service.cancel({
      workflowId: workflow.id,
      expectedRevision: 0
    });
    await expect(repository.save(cancelled, 0)).rejects.toBeInstanceOf(
      ConversationWorkflowRevisionConflictError
    );
  });

  it('atomically cancels an older pending workflow when a new task starts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-workflow-supersede-'));
    roots.push(root);
    let nextId = 0;
    const repository = new JsonConversationWorkflowRepository(
      new NodeProjectStorage(root),
      projectId,
      () => '2026-09-03T00:00:00.000Z'
    );
    const service = new ConversationWorkflowService(
      repository,
      new ConversationIntentOrchestrator(),
      () => '2026-09-03T00:00:00.000Z',
      () => toConversationWorkflowId(`workflow-supersede-${nextId++}`)
    );
    const first = await service.create({
      projectId,
      conversationId,
      sourceMessageId: toMessageId('message-supersede-1'),
      rawText: '帮我做个总结'
    });
    const second = await service.create({
      projectId,
      conversationId,
      sourceMessageId: toMessageId('message-supersede-2'),
      rawText: '做一份季度汇报 PPT'
    });

    expect(await repository.get(first.id)).toMatchObject({
      status: 'cancelled',
      revision: 1
    });
    expect(await service.getPending(conversationId)).toMatchObject({
      id: second.id,
      status: 'ready'
    });
  });

  it('keeps only one pending workflow across concurrent creates', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-workflow-concurrent-'));
    roots.push(root);
    let nextId = 0;
    const repository = new JsonConversationWorkflowRepository(
      new NodeProjectStorage(root),
      projectId,
      () => '2026-09-03T00:00:00.000Z'
    );
    const service = new ConversationWorkflowService(
      repository,
      new ConversationIntentOrchestrator(),
      () => '2026-09-03T00:00:00.000Z',
      () => toConversationWorkflowId(`workflow-concurrent-${nextId++}`)
    );

    await Promise.all([
      service.create({
        projectId,
        conversationId,
        sourceMessageId: toMessageId('message-concurrent-1'),
        rawText: '帮我做个总结'
      }),
      service.create({
        projectId,
        conversationId,
        sourceMessageId: toMessageId('message-concurrent-2'),
        rawText: '做一份季度汇报 PPT'
      })
    ]);

    const workflows = await repository.list(conversationId);
    expect(workflows.filter((item) =>
      ['needs_clarification', 'needs_confirmation', 'ready'].includes(item.status)
    )).toHaveLength(1);
    expect(workflows.filter((item) => item.status === 'cancelled')).toHaveLength(1);
  });

  it('resolves one document target from a later clarification turn', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-workflow-target-'));
    roots.push(root);
    const repository = new JsonConversationWorkflowRepository(
      new NodeProjectStorage(root),
      projectId,
      () => '2026-09-03T00:00:00.000Z'
    );
    const service = new ConversationWorkflowService(
      repository,
      new ConversationIntentOrchestrator(),
      () => '2026-09-03T00:00:00.000Z',
      () => toConversationWorkflowId('workflow-target')
    );
    const documents = [
      { messageId: 'ppt-target', kind: 'ppt' as const, fileName: '经营汇报.pptx' },
      { messageId: 'word-target', kind: 'word' as const, fileName: '经营方案.docx' }
    ];
    const created = await service.create({
      projectId,
      conversationId,
      sourceMessageId: toMessageId('message-target'),
      rawText: '再加一个例子',
      context: { documents }
    });
    expect(created.status).toBe('needs_clarification');

    const answered = await service.answer({
      workflowId: created.id,
      expectedRevision: created.revision,
      rawText: '改 PPT',
      context: { documents }
    });
    expect(answered).toMatchObject({
      status: 'ready',
      resolvedTarget: { artifactRef: 'ppt-target', version: 1 },
      plan: { documentKind: 'ppt', missing: [], ambiguities: [] }
    });
  });

  it('binds destructive confirmation to an expiring plan and closes execution state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-workflow-confirm-'));
    roots.push(root);
    let currentTime = '2026-09-03T00:00:00.000Z';
    const repository = new JsonConversationWorkflowRepository(
      new NodeProjectStorage(root),
      projectId,
      () => currentTime
    );
    const service = new ConversationWorkflowService(
      repository,
      new ConversationIntentOrchestrator(),
      () => currentTime,
      () => toConversationWorkflowId('workflow-confirm'),
      60_000
    );
    const created = await service.create({
      projectId,
      conversationId,
      sourceMessageId: toMessageId('message-confirm'),
      rawText: '删除刚才 PPT 的第二页',
      context: {
        documents: [
          { messageId: 'ppt-message', kind: 'ppt', fileName: '经营汇报.pptx' }
        ]
      }
    });
    expect(created).toMatchObject({
      status: 'needs_confirmation',
      confirmationId: expect.any(String),
      planHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      confirmationExpiresAt: '2026-09-03T00:01:00.000Z'
    });

    currentTime = '2026-09-03T00:00:30.000Z';
    const ready = await service.confirm({
      workflowId: created.id,
      expectedRevision: created.revision
    });
    const executing = await service.beginExecution({
      workflowId: ready.id,
      expectedRevision: ready.revision,
      executionId: 'pending:confirm'
    });
    const bound = await service.bindExecution({
      workflowId: executing.id,
      expectedRevision: executing.revision,
      executionId: 'response-confirm'
    });
    const completed = await service.finishExecution('response-confirm', 'completed');
    expect(bound.status).toBe('executing');
    expect(completed?.status).toBe('completed');
    expect(await service.getPending(conversationId)).toBeUndefined();
  });

  it('cancels an expired confirmation instead of replaying it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-workflow-expired-'));
    roots.push(root);
    let currentTime = '2026-09-03T00:00:00.000Z';
    const repository = new JsonConversationWorkflowRepository(
      new NodeProjectStorage(root),
      projectId,
      () => currentTime
    );
    const service = new ConversationWorkflowService(
      repository,
      new ConversationIntentOrchestrator(),
      () => currentTime,
      () => toConversationWorkflowId('workflow-expired'),
      1_000
    );
    const created = await service.create({
      projectId,
      conversationId,
      sourceMessageId: toMessageId('message-expired'),
      rawText: '删除刚才 PPT 的第二页',
      context: {
        documents: [
          { messageId: 'ppt-message', kind: 'ppt', fileName: '经营汇报.pptx' }
        ]
      }
    });
    currentTime = '2026-09-03T00:00:02.000Z';

    await expect(service.confirm({
      workflowId: created.id,
      expectedRevision: created.revision
    })).rejects.toMatchObject({
      code: 'confirmation_expired'
    });
    expect((await repository.get(created.id))?.status).toBe('cancelled');
  });
});
