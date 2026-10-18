import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationIntentOrchestrator, ConversationWorkflowService } from '../../src/application';
import { toConversationId, toConversationWorkflowId, toMessageId, toProjectId } from '../../src/domain';
import { JsonConversationWorkflowRepository } from '../../src/platform/repositories';
import { NodeProjectStorage } from '../../src/platform/storage';
import { chatFixturePlan, pptFixturePlan } from '../fixtures/conversation-semantic-classifier';
const roots: string[] = [];
const projectId = toProjectId('project-workflow-test'), conversationId = toConversationId('conversation-workflow-test');
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(plans: readonly unknown[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-semantic-workflow-')); roots.push(root);
  let clock = Date.parse('2026-10-17T12:00:00Z'), sequence = 0;
  const now = () => new Date(clock).toISOString();
  const replies = [...plans];
  const classify = vi.fn(async (_input: unknown) => { if (!replies.length) throw new Error('Unexpected semantic replan'); return replies.shift(); });
  const repository = new JsonConversationWorkflowRepository(new NodeProjectStorage(root), projectId, now);
  const service = new ConversationWorkflowService(repository, new ConversationIntentOrchestrator({ classifier: { classify } }), now,
    () => toConversationWorkflowId(`workflow-${++sequence}`), 1_000);
  const create = (rawText = '用户当前请求', id = conversationId) => service.create({ projectId, conversationId: id,
    sourceMessageId: toMessageId(`source-${sequence + 1}`), rawText });
  return { service, repository, classify, create, advance(ms: number) { clock += ms; } };
}
const multiple = { ...pptFixturePlan, documentKind: 'word', deliverables: ['word', 'ppt'] };

describe('workflow execution of one authoritative semantic plan', () => {
  it('preserves the model parameters and source policy instead of merging business meaning from prose', async () => {
    const f = await fixture([{ ...pptFixturePlan, sourcePolicy: 'internal', parameters: { topic: '模型确认的主题', style: '简洁' } }]);
    const result = await f.create('随便生成，联网和删除这两个词只是讨论内容');
    expect(result).toMatchObject({ status: 'ready', plan: { parameters: { topic: '模型确认的主题', style: '简洁' }, sourcePolicy: 'internal' } });
    expect(result.plan.parameters).toEqual({ topic: '模型确认的主题', style: '简洁' });
    expect(f.classify).toHaveBeenCalledOnce();
  });
  it('asks only the missing structured fields and passes the saved task to the next semantic call', async () => {
    const f = await fixture([{ ...pptFixturePlan, parameters: {}, missing: ['document_topic'], confidence: 'low' }, pptFixturePlan]);
    const first = await f.create('第一句话');
    expect(first.status).toBe('needs_clarification');
    const second = await f.service.answer({ workflowId: first.id, expectedRevision: first.revision, rawText: '随便选题做吧' });
    expect(second).toMatchObject({ id: first.id, revision: 1, status: 'ready', pendingQuestions: [] });
    expect(f.classify.mock.calls[1][0]).toMatchObject({ rawText: '随便选题做吧', context: { currentTask: { status: 'needs_clarification', plan: first.plan } } });
  });
  it('reads saved plans and pending state without any model replay', async () => {
    const f = await fixture([pptFixturePlan]), created = await f.create();
    expect(await f.service.get(created.id)).toEqual(created);
    expect((await f.service.getPending(conversationId))?.id).toBe(created.id);
    expect(f.classify).toHaveBeenCalledOnce();
  });
  it('confirms through the bound control operation and preserves the exact plan parameters', async () => {
    const f = await fixture([{ ...pptFixturePlan, needsConfirmation: true }]), pending = await f.create();
    expect(pending.status).toBe('needs_confirmation');
    const result = await f.service.confirm({ workflowId: pending.id, expectedRevision: pending.revision });
    expect(result.status).toBe('ready');
    expect(result.plan.parameters).toEqual(pending.plan.parameters);
    expect(f.classify).toHaveBeenCalledOnce();
  });
  it('rejects an expired control authorization without inferring fresh authorization from a phrase', async () => {
    const f = await fixture([{ ...pptFixturePlan, needsConfirmation: true }]), pending = await f.create();
    f.advance(2_000);
    await expect(f.service.confirm({ workflowId: pending.id, expectedRevision: pending.revision })).rejects.toMatchObject({ code: 'confirmation_expired' });
    expect((await f.service.get(pending.id))?.status).toBe('cancelled');
    expect(f.classify).toHaveBeenCalledOnce();
  });
  it('interprets a typed reply only through a new model plan', async () => {
    const f = await fixture([{ ...pptFixturePlan, needsConfirmation: true }, chatFixturePlan]);
    const pending = await f.create();
    const answered = await f.service.answer({ workflowId: pending.id, expectedRevision: pending.revision, rawText: '确认执行' });
    expect(answered.plan.kind).toBe('chat');
    expect(f.classify).toHaveBeenCalledTimes(2);
  });
  it('keeps multi-format deliveries ordered and advances after a registered result', async () => {
    const f = await fixture([multiple]), first = await f.create();
    await f.service.beginExecution({ workflowId: first.id, expectedRevision: first.revision, executionId: 'word-execution' });
    const next = await f.service.finishDocumentExecution('word-execution', 'completed', { messageId: 'word-result', workId: 'word-work' });
    expect(next).toMatchObject({ status: 'ready', plan: { documentKind: 'ppt' }, deliveries: [
      { kind: 'word', status: 'completed', workId: 'word-work' }, { kind: 'ppt', status: 'pending' }
    ] });
    await f.service.beginExecution({ workflowId: next!.id, expectedRevision: next!.revision, executionId: 'ppt-execution' });
    expect(await f.service.finishDocumentExecution('ppt-execution', 'completed', { messageId: 'ppt-result', workId: 'ppt-work' })).toMatchObject({ status: 'completed' });
    expect(f.classify).toHaveBeenCalledOnce();
  });
  it('keeps completed Work while retrying only a known failed delivery', async () => {
    const f = await fixture([multiple]), first = await f.create();
    await f.service.beginExecution({ workflowId: first.id, expectedRevision: first.revision, executionId: 'word-execution' });
    const next = (await f.service.finishDocumentExecution('word-execution', 'completed', { messageId: 'word-result', workId: 'word-work' }))!;
    await f.service.beginExecution({ workflowId: next.id, expectedRevision: next.revision, executionId: 'ppt-execution' });
    const failed = (await f.service.finishDocumentExecution('ppt-execution', 'failed', undefined, 'execution_failed'))!;
    const retry = await f.service.resumeFailedDelivery({ workflowId: failed.id, expectedRevision: failed.revision });
    expect(retry).toMatchObject({ status: 'ready', deliveries: [{ status: 'completed', workId: 'word-work' }, { kind: 'ppt', status: 'pending' }] });
  });
  it.each(['outcome_unknown', 'interrupted'] as const)('never automatically replays an %s result', async reason => {
    const f = await fixture([multiple]), first = await f.create();
    await f.service.beginExecution({ workflowId: first.id, expectedRevision: first.revision, executionId: 'unknown-execution' });
    const failed = (await f.service.finishDocumentExecution('unknown-execution', 'failed', undefined, reason))!;
    await expect(f.service.resumeFailedDelivery({ workflowId: failed.id, expectedRevision: failed.revision })).rejects.toBeDefined();
    expect(f.classify).toHaveBeenCalledOnce();
  });
  it('uses returned deliverables to cancel unstarted outputs without parsing negative phrases', async () => {
    const f = await fixture([multiple, { ...pptFixturePlan, deliverables: ['ppt'] }]), first = await f.create();
    const selected = await f.service.answer({ workflowId: first.id, expectedRevision: first.revision, rawText: '这次只需要演示稿' });
    expect(selected.deliveries).toMatchObject([{ kind: 'ppt', status: 'pending' }, { kind: 'word', status: 'cancelled' }]);
  });
  it('maps a structured cancel result to a terminal workflow', async () => {
    const f = await fixture([pptFixturePlan, { ...chatFixturePlan, kind: 'cancel' }]), first = await f.create();
    const cancelled = await f.service.answer({ workflowId: first.id, expectedRevision: first.revision, rawText: '本轮到这里' });
    expect(cancelled).toMatchObject({ status: 'cancelled', pendingQuestions: [] });
    expect(await f.service.getPending(conversationId)).toBeUndefined();
  });
  it('recovers only the locally authorized execution and leaves a live foreign lease intact', async () => {
    const f = await fixture([pptFixturePlan, pptFixturePlan]);
    const foreign = await f.create(), local = await f.create('第二个会话', toConversationId('local-conversation'));
    const leased = await f.service.beginExecution({ workflowId: foreign.id, expectedRevision: foreign.revision, executionId: 'foreign' });
    await f.service.beginExecution({ workflowId: local.id, expectedRevision: local.revision, executionId: 'local' });
    expect(await f.service.recoverInterruptedExecutions(async item => item.executionId === 'local')).toBe(1);
    expect(await f.service.get(foreign.id)).toEqual(leased);
    expect((await f.service.get(local.id))?.status).toBe('failed');
  });
  it('blocks execution for invalid or unavailable semantic plans', async () => {
    const f = await fixture([{ invalid: true }]), failed = await f.create();
    expect(failed).toMatchObject({ status: 'failed', planningFailureCode: 'invalid_intent_plan' });
    await expect(f.service.beginExecution({ workflowId: failed.id, expectedRevision: failed.revision, executionId: 'denied' })).rejects.toBeDefined();
  });
  it('rejects stale revisions and cross-project input before mutation', async () => {
    const f = await fixture([pptFixturePlan]), first = await f.create();
    await expect(f.service.beginExecution({ workflowId: first.id, expectedRevision: first.revision + 1, executionId: 'stale' })).rejects.toBeDefined();
    await expect(f.service.create({ projectId: toProjectId('foreign'), conversationId, sourceMessageId: toMessageId('foreign-source'), rawText: '跨项目' })).rejects.toThrow('scope');
    expect(await f.service.get(first.id)).toEqual(first);
    expect(f.classify).toHaveBeenCalledOnce();
  });
});
