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
  async function regressionService() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-workflow-language-'));
    roots.push(root);
    const now = () => '2026-09-09T00:00:00.000Z';
    const repository = new JsonConversationWorkflowRepository(new NodeProjectStorage(root), projectId, now);
    let nextId = 0;
    return new ConversationWorkflowService(repository, new ConversationIntentOrchestrator(), now, () =>
      toConversationWorkflowId(`workflow-language-${nextId++}`));
  }

  it.each([
    ['帮我做个总结', 'needs_clarification'],
    ['帮我做一份 PPT', 'ready'],
    ['删除刚才 PPT 的第二页', 'needs_confirmation']
  ])('accepts natural cancellation from a %s workflow', async (rawText, status) => {
    const service = await regressionService();
    const created = await service.create({
      projectId, conversationId, sourceMessageId: toMessageId('message-cancel-language'), rawText,
      context: { documents: [{ messageId: 'ppt-target', kind: 'ppt', fileName: '汇报.pptx' }] }
    });
    expect(created.status).toBe(status);
    const cancelled = await service.answer({
      workflowId: created.id, expectedRevision: created.revision, rawText: '不用做 PPT 了，取消'
    });
    expect(cancelled).toMatchObject({ status: 'cancelled', pendingQuestions: [] });
    await expect(service.beginExecution({
      workflowId: cancelled.id, expectedRevision: cancelled.revision, executionId: 'must-not-start'
    })).rejects.toMatchObject({ code: 'workflow_not_ready' });
    expect(await service.getPending(conversationId)).toBeUndefined();
  });

  it('records cancellation without an existing task as a valid new terminal workflow', async () => {
    const service = await regressionService();
    const cancelled = await service.create({ projectId, conversationId, sourceMessageId: toMessageId('message-new-cancellation'), rawText: '取消' });
    expect(cancelled).toMatchObject({ status: 'cancelled', revision: 0, pendingQuestions: [] });
    expect((await service.get(cancelled.id))?.status).toBe('cancelled');
    expect(await service.getPending(conversationId)).toBeUndefined();
  });

  it('supersedes a failed workflow without reviving it after a new request completes', async () => {
    const service = await regressionService();
    const initial = await service.create({ projectId, conversationId, sourceMessageId: toMessageId('message-old-failed'), rawText: '做 Word 和 PPT' });
    await service.beginExecution({ workflowId: initial.id, expectedRevision: initial.revision, executionId: 'old-failed' });
    await service.finishDocumentExecution('old-failed', 'failed');
    const fresh = await service.create({ projectId, conversationId, sourceMessageId: toMessageId('message-fresh-question'), rawText: '你好' });
    expect(await service.get(initial.id)).toMatchObject({ status: 'cancelled', deliveries: [{ status: 'cancelled' }, { status: 'cancelled' }] });
    await service.beginExecution({ workflowId: fresh.id, expectedRevision: fresh.revision, executionId: 'fresh-response' });
    await service.finishExecution('fresh-response', 'completed');
    expect(await service.getPending(conversationId)).toBeUndefined();
  });

  it('uses stable question fields and replaces a negated type before execution', async () => {
    const service = await regressionService();
    const created = await service.create({
      projectId, conversationId, sourceMessageId: toMessageId('message-correct-language'), rawText: '帮我做个总结'
    });
    expect(created.pendingQuestions).toEqual([{
      field: 'document_kind', question: '请补充或确认：文档类型（Word、Excel 或 PPT）', required: true
    }]);
    const corrected = await service.answer({
      workflowId: created.id, expectedRevision: created.revision,
      rawText: '不要 PPT，要 Word，重点讲第三季度销售'
    });
    expect(corrected).toMatchObject({ status: 'ready', plan: { documentKind: 'word', missing: [], ambiguities: [] } });
    expect(corrected.plan.parameters.requirements).toContain('第三季度销售');
  });

  it('re-evaluates destructive changes to a ready task with a fresh confirmation', async () => {
    const service = await regressionService();
    const context = { documents: [{ messageId: 'ppt-target', kind: 'ppt' as const, fileName: '汇报.pptx' }] };
    const created = await service.create({
      projectId, conversationId, sourceMessageId: toMessageId('message-destructive-language'),
      rawText: '把刚才 PPT 第二页改成时间线', context
    });
    expect(created.status).toBe('ready');
    const corrected = await service.answer({
      workflowId: created.id, expectedRevision: created.revision, rawText: '再删除第三页', context
    });
    expect(corrected).toMatchObject({ status: 'needs_confirmation', plan: { needsConfirmation: true }, confirmationId: expect.any(String) });
    await expect(service.beginExecution({ workflowId: corrected.id, expectedRevision: corrected.revision, executionId: 'unconfirmed' }))
      .rejects.toMatchObject({ code: 'confirmation_required' });
  });

  it('persists ordered Office deliveries and advances only after official Work registration', async () => {
    const service = await regressionService();
    const initial = await service.create({ projectId, conversationId, sourceMessageId: toMessageId('message-multiple'), rawText: '做一份 Word 方案和 PPT 汇报' });
    expect(initial).toMatchObject({ status: 'ready', plan: { documentKind: 'word', deliverables: ['word', 'ppt'] } });
    const reordered = await service.answer({ workflowId: initial.id, expectedRevision: initial.revision, rawText: '先做 PPT' });
    expect(reordered.deliveries?.map((item) => item.kind)).toEqual(['ppt', 'word']);
    const first = await service.beginExecution({ workflowId: reordered.id, expectedRevision: reordered.revision, executionId: 'delivery-ppt' });
    expect((await service.finishExecution('delivery-ppt', 'completed'))?.status).toBe('executing');
    await expect(service.finishDocumentExecution('delivery-ppt', 'completed')).rejects.toThrow('registered work');
    expect((await service.get(first.id))?.status).toBe('executing');
    const next = await service.finishDocumentExecution('delivery-ppt', 'completed', { messageId: 'result-ppt', workId: 'work-ppt' });
    expect(next).toMatchObject({ status: 'ready', plan: { documentKind: 'word' }, deliveries: [
      { kind: 'ppt', status: 'completed', workId: 'work-ppt', resultMessageId: 'result-ppt' },
      { kind: 'word', status: 'pending' }
    ] });
    expect(await service.finishDocumentExecution('delivery-ppt', 'completed', { messageId: 'duplicate', workId: 'duplicate' })).toBeUndefined();
    if (!next) throw new Error('Missing next document');
    await service.beginExecution({ workflowId: next.id, expectedRevision: next.revision, executionId: 'delivery-word' });
    expect(await service.finishDocumentExecution('delivery-word', 'completed', { messageId: 'result-word', workId: 'work-word' })).toMatchObject({
      status: 'completed', deliveries: [{ workId: 'work-ppt' }, { workId: 'work-word' }]
    });
    expect(await service.getPending(conversationId)).toBeUndefined();
  });

  it('keeps completed Work when a later delivery fails and retries only a known failed step', async () => {
    const service = await regressionService();
    const initial = await service.create({ projectId, conversationId, sourceMessageId: toMessageId('message-partial'), rawText: '做 Excel 和 PPT' });
    await service.beginExecution({ workflowId: initial.id, expectedRevision: initial.revision, executionId: 'first-excel' });
    const second = await service.finishDocumentExecution('first-excel', 'completed', { messageId: 'result-excel', workId: 'work-excel' });
    if (!second) throw new Error('Missing second document');
    await service.beginExecution({ workflowId: second.id, expectedRevision: second.revision, executionId: 'failed-ppt' });
    const failed = await service.finishDocumentExecution('failed-ppt', 'failed', undefined, 'execution_failed');
    expect(failed).toMatchObject({ status: 'failed', deliveries: [{ kind: 'excel', status: 'completed', workId: 'work-excel' }, { kind: 'ppt', status: 'failed' }] });
    if (!failed) throw new Error('Missing failure');
    expect((await service.getPending(conversationId))?.id).toBe(failed.id);
    const resumed = await service.resumeFailedDelivery({ workflowId: failed.id, expectedRevision: failed.revision });
    expect(resumed).toMatchObject({ status: 'ready', plan: { documentKind: 'ppt' }, deliveries: [{ workId: 'work-excel', status: 'completed' }, { kind: 'ppt', status: 'pending' }] });
    await service.beginExecution({ workflowId: resumed.id, expectedRevision: resumed.revision, executionId: 'retried-ppt' });
    expect(await service.finishDocumentExecution('retried-ppt', 'completed', { messageId: 'result-ppt', workId: 'work-ppt' })).toMatchObject({ status: 'completed' });
  });

  it.each(['outcome_unknown', 'interrupted'] as const)('does not resubmit a delivery whose external result is %s', async (failureReason) => {
    const service = await regressionService();
    const initial = await service.create({ projectId, conversationId, sourceMessageId: toMessageId('message-unknown'), rawText: '做 Word 和 PPT' });
    await service.beginExecution({ workflowId: initial.id, expectedRevision: initial.revision, executionId: 'unknown-result' });
    const failed = await service.finishDocumentExecution('unknown-result', 'failed', undefined, failureReason);
    if (!failed) throw new Error('Missing unknown result');
    await expect(service.resumeFailedDelivery({ workflowId: failed.id, expectedRevision: failed.revision })).rejects.toMatchObject({ code: 'workflow_not_ready' });
  });

  it('reuses persisted model content when only local document generation failed', async () => {
    const service = await regressionService();
    const initial = await service.create({ projectId, conversationId, sourceMessageId: toMessageId('message-local-failure'), rawText: '做 Word 和 PPT' });
    await service.beginExecution({ workflowId: initial.id, expectedRevision: initial.revision, executionId: 'original-model-execution' });
    const failed = await service.finishDocumentExecution('original-model-execution', 'failed', { messageId: 'persisted-model-content' }, 'execution_failed');
    if (!failed) throw new Error('Missing local failure');
    const resumed = await service.resumeFailedDelivery({ workflowId: failed.id, expectedRevision: failed.revision });
    expect(resumed).toMatchObject({ status: 'executing', executionId: 'original-model-execution', deliveries: [
      { kind: 'word', status: 'executing', resultMessageId: 'persisted-model-content', executionId: 'original-model-execution' },
      { kind: 'ppt', status: 'pending' }
    ] });
    await expect(service.beginExecution({ workflowId: resumed.id, expectedRevision: resumed.revision, executionId: 'unnecessary-model-call' })).rejects.toMatchObject({ code: 'workflow_not_ready' });
    expect(await service.finishDocumentExecution('original-model-execution', 'completed', { messageId: 'persisted-model-content', workId: 'work-after-local-retry' }))
      .toMatchObject({ status: 'ready', plan: { documentKind: 'ppt' } });
  });

  it('cancels unstarted Office outputs without cancelling completed Work', async () => {
    const service = await regressionService();
    const initial = await service.create({ projectId, conversationId, sourceMessageId: toMessageId('message-selective'), rawText: '做 Word 和 PPT' });
    const selected = await service.answer({ workflowId: initial.id, expectedRevision: initial.revision, rawText: '只做 PPT，Word 不做了' });
    expect(selected).toMatchObject({ plan: { deliverables: ['ppt'], documentKind: 'ppt' }, deliveries: [{ kind: 'ppt', status: 'pending' }, { kind: 'word', status: 'cancelled' }] });
    await service.beginExecution({ workflowId: selected.id, expectedRevision: selected.revision, executionId: 'selected-ppt' });
    const completed = await service.finishDocumentExecution('selected-ppt', 'completed', { messageId: 'result-ppt', workId: 'work-ppt' });
    expect(completed).toMatchObject({ status: 'completed', deliveries: [{ status: 'completed' }, { status: 'cancelled' }] });
  });

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

  it('recovers an unknown workflow across multiple terse clarification turns', async () => {
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

    const stillUnknown = await service.answer({
      workflowId: created.id,
      expectedRevision: created.revision,
      rawText: '制作',
      context: {
        recentUserMessages: ['帮我做一个关于龙的', '制作']
      }
    });
    expect(stillUnknown.status).toBe('needs_clarification');

    const answered = await service.answer({
      workflowId: stillUnknown.id,
      expectedRevision: stillUnknown.revision,
      rawText: 'ppt',
      context: {
        recentUserMessages: ['帮我做一个关于龙的', '制作', 'ppt']
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
    expect((await service.finishExecution('response-confirm', 'completed'))?.status).toBe('executing');
    const completed = await service.finishDocumentExecution('response-confirm', 'completed', { messageId: 'result-confirm', workId: 'work-confirm' });
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
