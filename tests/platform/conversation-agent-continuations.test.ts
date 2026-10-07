import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addCompletedAssistantMessage, attachConversationAgentRunExecution, attachDocumentResultToMessage, createConversationAgentRun, parseConversation, toConversationAgentRunId, toConversationId,
  toConversationResponseExecutionId, toIsoTimestamp, toMessageId, toProjectId, toWorkId,
  type ConversationAgentSessionV1, type ControlledConversationInputReferenceV1 } from '../../src/domain';
import { ConversationApplicationService } from '../../src/application/conversation-service';
import { ConversationAgentSessionService } from '../../src/application/conversation-agent-session-service';
import type { ConversationIntentClassifierPort } from '../../src/application/conversation-intent-orchestrator';
import { ConversationAgentContinuationRuntime } from '../../src/platform/ipc/conversation-agent-continuations';
import { toConversationDto } from '../../src/platform/ipc/conversation-controller';
import { JsonConversationRepository } from '../../src/platform/repositories/json-conversation-repository';
import { JsonConversationAgentRunRepository } from '../../src/platform/repositories/json-conversation-agent-run-repository';
import { JsonConversationAgentSessionRepository } from '../../src/platform/repositories/json-conversation-agent-session-repository';
import { NodeProjectStorage } from '../../src/platform/storage';
import type { ConversationAgentResponseStartDto, StartResponseRequest } from '../../src/shared/chat-context-ipc';

const roots: string[] = [], services: ConversationAgentSessionService[] = [];
const start = Date.parse('2026-10-04T12:00:00.000Z'), projectId = toProjectId('continuation-project');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  await Promise.all(roots.splice(0).map(async root => {
    if (path.dirname(path.resolve(root)).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !path.basename(root).startsWith('unicomp-continuations-')) throw new Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  }));
});
async function setup(classifier?: ConversationIntentClassifierPort, supportsMutation?: boolean) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-continuations-')); roots.push(root);
  let now = start, messageIndex = 0, tokenIndex = 0, current = true;
  const at = () => new Date(now).toISOString(), storage = new NodeProjectStorage(root);
  const conversationsRepository = new JsonConversationRepository(path.join(root, 'conversations.json'), at);
  const conversations = new ConversationApplicationService(conversationsRepository, {
    nextConversationId: () => toConversationId('continuation-conversation'), nextMessageId: () => toMessageId(`continuation-message-${++messageIndex}`)
  }, at);
  const conversation = await conversations.create({ title: 'Continuation fixture', projectId });
  const sessions = new JsonConversationAgentSessionRepository(storage, projectId, at), agentRuns = new JsonConversationAgentRunRepository(storage, projectId, at);
  let runtime: ConversationAgentContinuationRuntime;
  const service = new ConversationAgentSessionService({ repository: sessions, ownerId: 'continuation-host', now: () => now, hash,
    nextResumeToken: () => `continuation-token-${String(++tokenIndex).padStart(24, '0')}`,
    recheckContinuation: input => runtime.validateReferences(input.session, input.inputReference) }); services.push(service);
  const replay = vi.fn(async (_responseExecutionId: string): Promise<ConversationAgentResponseStartDto> => ({
    conversation: toConversationDto(await conversations.get(conversation.id)), agentSession: (await runtime.list(conversation.id))[0], waiting: true
  }));
  const cancelExecution = vi.fn(async (_responseExecutionId: string) => undefined);
  runtime = new ConversationAgentContinuationRuntime({ storage, projectId, sessions, sessionService: service, agentRuns, conversations,
    isCurrent: () => current, now: at, classifier, supportsGeneration: true, supportsMutation, replayExecution: replay, cancelExecution });
  const request = (content: string, continuation?: StartResponseRequest['continuation'], commandId = `command-${messageIndex + 1}`): StartResponseRequest => ({
    clientCommandId: commandId, conversation: { conversationId: conversation.id, expectedRevision: 0, editedMessageId: null },
    title: 'Continuation fixture', content, continuation, productFeature: 'text_chat', candidateId: 'synthetic-candidate',
    contextSelections: [], parameterValues: {}, confirmed: false, agentNative: true
  });
  const prepare = async (input: StartResponseRequest, signal = new AbortController().signal) => {
    let latest = await conversations.get(conversation.id);
    await runtime.controller.validate!({ conversation: latest, input, signal });
    latest = await conversations.addUserMessage({ conversationId: latest.id, expectedRevision: latest.revision, content: input.content,
      ...(input.displayContent === undefined ? {} : { displayContent: input.displayContent }) });
    const userMessageId = latest.messages.at(-1)!.id;
    const result = await runtime.controller.prepare({ conversation: latest, userMessageId, input, signal });
    return { ...result, userMessageId };
  };
  const getSession = async (id: string) => (await sessions.get(toConversationAgentRunId(id)))!;
  const bind = async (prepared: Awaited<ReturnType<typeof prepare>>, responseId = 'continuation-response') => {
    const runId = prepared.reservedRunId ?? `initial-child-${messageIndex}`;
    const run = createConversationAgentRun({ id: toConversationAgentRunId(runId), projectId, conversationId: conversation.id,
      sourceMessageId: toMessageId(prepared.userMessageId), parentRunId: toConversationAgentRunId(prepared.agentSession.sessionId), createdAt: toIsoTimestamp(at()) });
    await agentRuns.create(run);
    await runtime.controller.bindRun({ sessionId: prepared.agentSession.sessionId, runId });
    await agentRuns.save(attachConversationAgentRunExecution(run, toConversationResponseExecutionId(responseId), toIsoTimestamp(at())), run.revision);
    await runtime.controller.bindExecution({ sessionId: prepared.agentSession.sessionId, runId, responseExecutionId: responseId });
    return run;
  };
  return { root, storage, sessions, agentRuns, conversations, conversationsRepository, runtime, service, replay, cancelExecution, conversation, request, prepare, bind, getSession,
    setTime(value: number) { now = value; }, setCurrent(value: boolean) { current = value; } };
}
function continuation(session: { sessionId: string; revision: number; resumeToken?: string }, action: 'reply' | 'authorize' | 'continue' = 'reply'): NonNullable<StartResponseRequest['continuation']> {
  return { sessionId: session.sessionId, expectedRevision: session.revision, resumeToken: session.resumeToken!, action };
}

describe('Host conversation continuations', () => {
  it('keeps existing-PPT discussion within the available generation profile when mutation rendering is unavailable', async () => {
    const f = await setup(undefined, false), base = await f.conversations.get(f.conversation.id);
    const withReply = addCompletedAssistantMessage(base, { id: toMessageId('offline-renderer-artifact'), content: '已交付', createdAt: toIsoTimestamp(new Date(start).toISOString()) });
    await f.conversationsRepository.save(withReply, base.revision);
    await f.conversationsRepository.save(attachDocumentResultToMessage(withReply, withReply.messages.at(-1)!.id,
      { workId: toWorkId('offline-renderer-ppt'), kind: 'ppt', fileName: '已保存.pptx', sizeBytes: 100 }, toIsoTimestamp(new Date(start).toISOString())), withReply.revision);
    const prepared = await f.prepare(f.request('先讨论一下文案，不修改文件'));
    expect(prepared.waiting).toBe(false);
    expect((await f.getSession(prepared.agentSession.sessionId)).budget).toMatchObject({ maxToolCalls: 8, budgetUnits: 24, deadlineAt: start + 360_000 });
  });
  it('takes explicit complete generation through local planning without another model or confirmation', async () => {
    const classifier = { classify: vi.fn(async () => { throw new Error('unnecessary classification'); }) };
    const f = await setup(classifier), ready = await f.prepare(f.request('制作一份关于龙的传说的10页PPT'));
    expect(ready).toMatchObject({ waiting: false, agentSession: { state: 'running' } });
    expect(classifier.classify).not.toHaveBeenCalled();
    const session = await f.getSession(ready.agentSession.sessionId);
    expect(session).toMatchObject({ budget: { startedAt: start, deadlineAt: start + 360_000, maxToolCalls: 8, budgetUnits: 24 }, planningBoundary: 'not_started' });
    expect((await f.agentRuns.get(session.id))?.responseExecutionId).toBeUndefined();
    const child = await f.bind(ready);
    expect((await f.getSession(session.id)).childSegments).toHaveLength(2);
    expect(await f.runtime.executionContext('continuation-response')).toMatchObject({ policy: { startedAt: start, deadlineAt: start + 360_000, maxToolCalls: 8, budgetUnits: 24 } });
    expect(child.parentRunId).toBe(session.id);
  });
  it('persists a missing topic and binds the answer to the same root and original deadline', async () => {
    const f = await setup(), waiting = await f.prepare(f.request('制作一个PPT'));
    expect(waiting).toMatchObject({ waiting: true, agentSession: { state: 'waiting_user', waiting: { allowedActions: ['reply'] } } });
    expect(waiting.agentSession.resumeToken).toBeTruthy();
    const original = await f.getSession(waiting.agentSession.sessionId);
    expect(JSON.stringify(original)).not.toContain(waiting.agentSession.resumeToken);
    f.setTime(start + 60_000);
    const resumed = await f.prepare(f.request('关于龙的传说，给小学生看，做10页', continuation(waiting.agentSession), 'reply-command'));
    expect(resumed).toMatchObject({ waiting: false, parentRunId: original.id });
    expect(resumed.workflow).toMatchObject({ status: 'ready', plan: { kind: 'document', action: 'create', documentKind: 'ppt' } });
    expect(resumed.workflow?.plan.parameters.requirements).toContain('关于龙的传说');
    expect(resumed.workflow?.plan.parameters.requirements).toContain('制作一个PPT');
    const current = await f.getSession(original.id);
    expect(current.budget).toEqual(original.budget); expect(current.inputReferences).toHaveLength(2);
    expect(current.childSegments).toHaveLength(2); expect(current.resumeReceipts).toHaveLength(1);
    expect(current.leaseEpoch).toBe(original.leaseEpoch + 1);
    await f.bind(resumed);
  });
  it('keeps successive discussion turns and a short approval on the native history route', async () => {
    const classifier = { classify: vi.fn(async () => { throw new Error('duplicate semantic dispatch'); }) }, f = await setup(classifier);
    for (const content of ['我想做一个《交换A》的 PPT。', '主要讲两个家庭交换身份以后发生的冲突。', '人物关系和冲突重点一点。', '可以']) {
      const prepared = await f.prepare(f.request(content));
      expect(prepared.waiting).toBe(false);
      await f.service.settle(toConversationAgentRunId(prepared.agentSession.sessionId), 'completed'); f.runtime.discardPreparation(prepared.agentSession.sessionId);
    }
    expect(classifier.classify).not.toHaveBeenCalled();
    expect((await f.conversations.get(f.conversation.id)).messages.filter(message => message.role === 'user').map(message => message.content)).toHaveLength(4);
  });
  it('keeps a bare acknowledgment waiting for the topic rather than treating it as complete authorization', async () => {
    const f = await setup(), first = await f.prepare(f.request('制作一个PPT'));
    const next = await f.prepare(f.request('好的', continuation(first.agentSession)));
    expect(next).toMatchObject({ waiting: true, agentSession: { state: 'waiting_user', waiting: { allowedActions: ['reply'] } } });
    expect(next.agentSession.sessionId).toBe(first.agentSession.sessionId);
    expect(next.agentSession.resumeToken).not.toBe(first.agentSession.resumeToken);
    expect((await f.getSession(next.agentSession.sessionId)).budget.deadlineAt).toBe(start + 360_000);
  });
  it('offers only the already bound response for a duplicate command and rejects changed text or nonce', async () => {
    const f = await setup(), waiting = await f.prepare(f.request('制作一个PPT'));
    const input = f.request('关于龙的传说的10页PPT', continuation(waiting.agentSession), 'repeat-command');
    const resumed = await f.prepare(input); await f.bind(resumed, 'duplicate-bound-response');
    const before = await f.getSession(waiting.agentSession.sessionId), latest = await f.conversations.get(f.conversation.id), signal = new AbortController().signal;
    expect(await f.runtime.controller.validate!({ conversation: latest, input, signal })).toBeDefined();
    expect(f.replay).toHaveBeenCalledOnce(); expect(f.replay).toHaveBeenCalledWith('duplicate-bound-response');
    expect(await f.getSession(before.id)).toEqual(before);
    await expect(f.runtime.controller.validate!({ conversation: latest, input: { ...input, content: '不同的要求' }, signal })).rejects.toMatchObject({ code: 'continuation_invalid' });
    await expect(f.runtime.controller.validate!({ conversation: latest, input: { ...input, continuation: { ...input.continuation!, resumeToken: 'forged-token-that-is-long-enough' } }, signal })).rejects.toMatchObject({ code: 'continuation_invalid' });
  });
  it('rejects an expired answer and does not reset the absolute task budget', async () => {
    const f = await setup(), waiting = await f.prepare(f.request('制作一个PPT')), before = await f.getSession(waiting.agentSession.sessionId);
    f.setTime(before.budget.deadlineAt);
    await expect(f.prepare(f.request('关于龙的传说', continuation(waiting.agentSession)))).rejects.toMatchObject({ code: 'expired' });
    expect(await f.getSession(before.id)).toEqual(before);
    expect((await f.runtime.list(f.conversation.id))[0]).toMatchObject({ state: 'expired' });
  });
  it('keeps an unknown result blocking new tasks even after its deadline', async () => {
    const f = await setup(), ready = await f.prepare(f.request('你好'));
    await f.service.freeze(toConversationAgentRunId(ready.agentSession.sessionId), []);
    f.setTime(start + 360_001);
    await expect(f.prepare(f.request('制作新的龙传说PPT'))).rejects.toMatchObject({ code: 'unknown_result' });
    expect((await f.runtime.list(f.conversation.id))[0].state).toBe('needs_reconciliation');
  });
  it('rejects pinned message changes before consuming a resume nonce', async () => {
    const f = await setup(), waiting = await f.prepare(f.request('制作一个PPT'));
    const current = await f.conversations.get(f.conversation.id), original = current.messages.find(message => message.id === waiting.userMessageId)!;
    await f.conversationsRepository.save(parseConversation({ ...current, revision: current.revision + 1,
      messages: current.messages.map(message => message.id === original.id ? { ...message, revision: message.revision + 1, content: '被替换的要求' } : message) }), current.revision);
    const before = await f.getSession(waiting.agentSession.sessionId);
    await expect(f.prepare(f.request('关于龙的传说', continuation(waiting.agentSession)))).rejects.toMatchObject({ code: 'reference_changed' });
    expect(await f.getSession(before.id)).toEqual(before);
  });
  it('never infers an unsupported input reference or accepts a stale project scope', async () => {
    const f = await setup(), ready = await f.prepare(f.request('你好')), session = await f.getSession(ready.agentSession.sessionId);
    const unsupported: ControlledConversationInputReferenceV1 = { kind: 'document_draft', id: 'unsupported-draft', version: 0, contentHash: 'a'.repeat(64) };
    await expect(f.runtime.validateReferences(session, unsupported)).rejects.toMatchObject({ code: 'reference_changed' });
    f.setCurrent(false);
    await expect(f.runtime.list(f.conversation.id)).rejects.toMatchObject({ code: 'scope_mismatch' });
    await expect(f.runtime.validateReferences(session)).rejects.toMatchObject({ code: 'scope_mismatch' });
  });
  it('uses existing document identity to avoid asking which sole PPT should be revised', async () => {
    const classifier = { classify: vi.fn(async () => { throw new Error('unnecessary classification'); }) };
    const f = await setup(classifier);
    const base = await f.conversations.get(f.conversation.id);
    const withReply = addCompletedAssistantMessage(base, { id: toMessageId('fixture-artifact-message'), content: '已交付', createdAt: toIsoTimestamp(new Date(start).toISOString()) });
    await f.conversationsRepository.save(withReply, base.revision);
    await f.conversationsRepository.save(attachDocumentResultToMessage(withReply, withReply.messages.at(-1)!.id,
      { workId: toWorkId('fixture-ppt'), kind: 'ppt', fileName: '龙的传说.pptx', sizeBytes: 100 }, toIsoTimestamp(new Date(start).toISOString())), withReply.revision);
    const prepared = await f.prepare(f.request('把刚才的PPT标题改成龙的传说'));
    expect(prepared.waiting).toBe(false); expect(classifier.classify).not.toHaveBeenCalled();
    expect((await f.getSession(prepared.agentSession.sessionId)).budget).toMatchObject({ maxToolCalls: 12, budgetUnits: 32, deadlineAt: start + 540_000 });
  });
  it('cancels a persisted waiting task without leaving a resume challenge', async () => {
    const f = await setup(), waiting = await f.prepare(f.request('制作一个PPT'));
    const cancelled = await f.runtime.controller.cancel({ sessionId: waiting.agentSession.sessionId, expectedRevision: waiting.agentSession.revision });
    expect(cancelled).toMatchObject({ state: 'cancelled' }); expect(cancelled.resumeToken).toBeUndefined();
    expect(f.cancelExecution).not.toHaveBeenCalled();
    await expect(f.prepare(f.request('关于龙的传说', continuation(waiting.agentSession)))).rejects.toMatchObject({ code: 'closed' });
  });
  it('closes an abandoned unbound resumed child even when an earlier child has a response', async () => {
    const f = await setup(), initial = await f.prepare(f.request('你好')), child = await f.bind(initial, 'previous-response');
    await f.service.recordSegment({ runId: child.id, toolCallsUsed: 2, costUnitsUsed: 6, toolAttemptsUsed: 2, status: 'settled' });
    const waiting = await f.service.wait(toConversationAgentRunId(initial.agentSession.sessionId), { reason: 'safe_continuation', allowedActions: ['continue'] }); f.runtime.cacheChallenge(waiting);
    const dto = (await f.runtime.list(f.conversation.id))[0]; f.setTime(start + 30_000);
    const resumed = await f.prepare(f.request('继续', continuation(dto, 'continue')));
    expect(f.service.remainingPolicy(await f.getSession(dto.sessionId))).toEqual({ startedAt: start, deadlineAt: start + 360_000, maxToolCalls: 6, budgetUnits: 18 });
    await f.runtime.controller.abandon!({ sessionId: dto.sessionId, cancelled: false });
    expect(await f.getSession(dto.sessionId)).toMatchObject({ status: 'closed', closedReason: 'failed' });
    expect(resumed.reservedRunId).toBeTruthy();
  });
  it('rotates the waiting nonce after recovery and exposes only a verified cached challenge', async () => {
    const f = await setup(), old = await f.prepare(f.request('制作一个PPT'));
    f.runtime.discardPreparation(old.agentSession.sessionId);
    expect((await f.runtime.list(f.conversation.id))[0].resumeToken).toBeUndefined();
    await f.service.claimRecovery(toConversationAgentRunId(old.agentSession.sessionId));
    const fresh = await f.service.wait(toConversationAgentRunId(old.agentSession.sessionId), { reason: 'clarification', allowedActions: ['reply'] });
    expect(() => f.runtime.cacheChallenge({ ...fresh, resumeToken: 'forged-long-enough-resume-token' })).toThrowError('continuation_invalid');
    f.runtime.cacheChallenge(fresh); const dto = (await f.runtime.list(f.conversation.id))[0];
    expect(dto.resumeToken).toBe(fresh.resumeToken); expect(dto.resumeToken).not.toBe(old.agentSession.resumeToken);
    await expect(f.prepare(f.request('关于龙的传说', continuation(old.agentSession)))).rejects.toMatchObject({ code: 'continuation_invalid' });
    expect((await f.prepare(f.request('关于龙的传说', continuation(dto)))).waiting).toBe(false);
  });
  it('freezes lost planning replies without inventing a zero-effect response', async () => {
    const classify = vi.fn(async () => { throw new Error('synthetic transport lost reply'); });
    const f = await setup({ classify });
    await expect(f.prepare(f.request('把报告弄一下'))).rejects.toMatchObject({ code: 'continuation_invalid' });
    const session = (await f.sessions.list())[0];
    expect(classify).toHaveBeenCalledOnce(); expect(session).toMatchObject({ status: 'needs_reconciliation', planningBoundary: 'submitted' });
    expect(session.childSegments[0]).toMatchObject({ planningBoundary: 'submitted', status: 'unknown' });
    expect(session.childSegments[0].responseExecutionId).toBeUndefined();
    expect((await f.runtime.list(f.conversation.id))[0]).toMatchObject({ state: 'needs_reconciliation', canCloseUnknown: true });
  });
  it('tracks received planning separately and closes a schema-invalid answer as a known failure', async () => {
    const classify = vi.fn(async () => ({ invalidPlan: true })), f = await setup({ classify });
    await expect(f.prepare(f.request('把报告弄一下'))).rejects.toMatchObject({ code: 'continuation_invalid' });
    expect((await f.sessions.list())[0]).toMatchObject({ status: 'closed', closedReason: 'failed', planningBoundary: 'received' });
  });
  it('supplies the user-selected semantic model route before a complex classifier dispatch', async () => {
    const classify = vi.fn(async (input: Parameters<ConversationIntentClassifierPort['classify']>[0]) => {
      if (!input.context.semanticCandidate) throw new Error('semantic model route unavailable');
      expect(input.context.semanticCandidate).toEqual({ candidateId: 'synthetic-candidate', productFeature: 'text_chat' });
      expect(input.signal.aborted).toBe(false);
      return { schemaVersion: 1, kind: 'chat', parameters: {}, sourcePolicy: 'none', missing: [], ambiguities: [], confidence: 'high', needsConfirmation: false };
    }), f = await setup({ classify });
    const prepared = await f.prepare(f.request('把报告弄一下'));
    expect(prepared.waiting).toBe(false); expect(classify).toHaveBeenCalledOnce();
    expect(await f.getSession(prepared.agentSession.sessionId)).toMatchObject({ status: 'active', planningBoundary: 'received' });
  });
  it('freezes an explicitly cancelled planner after submission and retains the unknown cause', async () => {
    const controller = new AbortController();
    const classify = vi.fn(async () => { controller.abort(); throw new Error('planning cancelled after submission'); });
    const f = await setup({ classify });
    await expect(f.prepare(f.request('把报告弄一下'), controller.signal)).rejects.toBeDefined();
    expect((await f.sessions.list())[0]).toMatchObject({ status: 'needs_reconciliation', planningBoundary: 'submitted' });
  });
  it('closes a planner-only unknown result only after explicit confirmation while retaining its submitted evidence', async () => {
    const f = await setup({ classify: vi.fn(async () => { throw new Error('planning lost reply'); }) });
    await expect(f.prepare(f.request('把报告弄一下'))).rejects.toMatchObject({ code: 'continuation_invalid' });
    const unknown = (await f.sessions.list())[0];
    await expect(f.runtime.controller.cancel({ sessionId: unknown.id, expectedRevision: unknown.revision })).rejects.toMatchObject({ code: 'unknown_result' });
    const closed = await f.runtime.controller.cancel({ sessionId: unknown.id, expectedRevision: unknown.revision, closeUnknown: true });
    expect(closed.state).toBe('cancelled'); expect(closed.canCloseUnknown).toBeUndefined();
    expect(await f.getSession(unknown.id)).toMatchObject({ status: 'closed', planningBoundary: 'submitted',
      reconciliationAcknowledgement: { source: 'user_confirmation' } });
    expect((await f.getSession(unknown.id)).childSegments).toEqual(unknown.childSegments);
    expect((await f.prepare(f.request('现在只回复一句话'))).waiting).toBe(false);
  });
  it('refuses the planner-only close path once a child response has been bound', async () => {
    const f = await setup(), ready = await f.prepare(f.request('你好')); await f.bind(ready);
    const unknown = await f.service.freeze(toConversationAgentRunId(ready.agentSession.sessionId), []);
    expect((await f.runtime.list(f.conversation.id))[0].canCloseUnknown).toBeUndefined();
    await expect(f.runtime.controller.cancel({ sessionId: unknown.id, expectedRevision: unknown.revision, closeUnknown: true })).rejects.toMatchObject({ code: 'continuation_invalid' });
    expect(await f.getSession(unknown.id)).toEqual(unknown);
  });
  it('captures a resumed planning request independently from the received initial boundary', async () => {
    let call = 0;
    const classify = vi.fn(async () => {
      if (++call === 2) throw new Error('resumed planning lost response');
      return { schemaVersion: 1, kind: 'unknown', parameters: {}, sourcePolicy: 'none', missing: ['document_kind'], ambiguities: [], confidence: 'low', needsConfirmation: false };
    });
    const f = await setup({ classify }), waiting = await f.prepare(f.request('把报告弄一下'));
    expect(waiting.waiting).toBe(true);
    await expect(f.prepare(f.request('把材料转换成领导汇报', continuation(waiting.agentSession)))).rejects.toMatchObject({ code: 'continuation_invalid' });
    const session: ConversationAgentSessionV1 = await f.getSession(waiting.agentSession.sessionId);
    expect(session).toMatchObject({ planningBoundary: 'received', status: 'needs_reconciliation' });
    expect(session.childSegments.at(-1)).toMatchObject({ planningBoundary: 'submitted', status: 'unknown' });
  });
});
