import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationAgentSessionService, type ConversationAgentContinuationRequest, type ConversationAgentSessionServiceOptions } from '../../src/application/conversation-agent-session-service';
import { createConversationAgentRun, attachConversationAgentRunExecution, markConversationAgentRunNeedsReconciliation, acknowledgeConversationAgentRunReconciliation, confirmConversationAgentRunProjectedCompletion,
  evaluateConversationExecutionCompletion, updateConversationAgentSession, toConversationAgentRunId, toConversationId, toConversationResponseExecutionId, toIsoTimestamp, toMessageId, toProjectId, toWorkId,
  type ConversationAgentSessionRepository, type ControlledConversationInputReferenceV1 } from '../../src/domain';
import { JsonConversationAgentSessionRepository } from '../../src/platform/repositories/json-conversation-agent-session-repository';
import { JsonConversationCompletionJournal } from '../../src/platform/repositories/json-conversation-completion-journal';
import { NodeProjectStorage } from '../../src/platform/storage';

const roots: string[] = [], services: ConversationAgentSessionService[] = [];
const start = Date.parse('2026-10-04T12:00:00.000Z'), projectId = toProjectId('session-service-project'), conversationId = toConversationId('session-service-conversation');
const sessionId = toConversationAgentRunId('session-service-root'), sourceMessageId = toMessageId('session-service-source');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const source: ControlledConversationInputReferenceV1 = { kind: 'message', id: sourceMessageId, version: 0, contentHash: 'a'.repeat(64) };
const followup: ControlledConversationInputReferenceV1 = { kind: 'message', id: 'session-service-followup', version: 0, contentHash: 'b'.repeat(64) };
afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map(async root => {
    if (path.dirname(path.resolve(root)).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !path.basename(root).startsWith('unicomp-session-service-')) throw new Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  }));
});
async function setup(options: { readonly recheck?: ConversationAgentSessionServiceOptions['recheckContinuation']; readonly overrideRepository?: (repository: ConversationAgentSessionRepository) => ConversationAgentSessionRepository; readonly signal?: AbortSignal } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-session-service-')); roots.push(root);
  let now = start + 1, token = 0, rechecks = 0;
  const repository = new JsonConversationAgentSessionRepository(new NodeProjectStorage(root), projectId, () => new Date(now).toISOString());
  const actualRepository = options.overrideRepository?.(repository) ?? repository;
  const create = (ownerId: string) => {
    const service = new ConversationAgentSessionService({ repository: actualRepository, ownerId, now: () => now, hash,
      nextResumeToken: () => `opaque-session-resume-token-${++token}`, leaseTtlMs: 1000,
      recheckContinuation: async input => { rechecks++; await options.recheck?.(input); } }); services.push(service); return service;
  };
  const service = create('host-a'), run = createConversationAgentRun({ id: sessionId, projectId, conversationId, sourceMessageId, createdAt: toIsoTimestamp(new Date(start).toISOString()) });
  const budget = { startedAt: start, deadlineAt: start + 360_000, maxToolCalls: 8, budgetUnits: 24 };
  const open = await service.open({ run, budget, inputReferences: [source], signal: options.signal });
  return { root, service, repository, create, run, budget, open, get rechecks() { return rechecks; }, setTime(value: number) { now = value; } };
}
async function awaiting(fixture: Awaited<ReturnType<typeof setup>>) {
  return fixture.service.wait(sessionId, { reason: 'clarification', allowedActions: ['reply'] });
}
function resumeRequest(waiting: Awaited<ReturnType<typeof awaiting>>, patch: Partial<ConversationAgentContinuationRequest> = {}): ConversationAgentContinuationRequest {
  return { sessionId, projectId, conversationId, expectedRevision: waiting.session.revision, resumeToken: waiting.resumeToken,
    commandId: 'reply-command', action: 'reply', childRunId: toConversationAgentRunId('session-service-child-1'), sourceMessageId: toMessageId(followup.id), inputReference: followup, ...patch };
}
describe('ConversationAgentSessionService', () => {
  it('rejects an inactive child from the fresh primary lease read even after its identity was indexed', async () => {
    const fixture = await setup();
    const run = createConversationAgentRun({ id: toConversationAgentRunId('indexed-child'), parentRunId: sessionId,
      projectId, conversationId, sourceMessageId, createdAt: fixture.run.createdAt });
    await fixture.service.admitInitialSegment({ sessionId, run, inputReference: source });
    await fixture.service.assertExecutionOwnershipIfPresent(run.id);
    await fixture.service.recordSegment({ runId: run.id, toolCallsUsed: 0, costUnitsUsed: 0, toolAttemptsUsed: 0, status: 'settled' });
    await expect(fixture.service.assertExecutionOwnershipIfPresent(run.id)).rejects.toThrow('lease_lost');
    await expect(fixture.service.executionContextForRun(run.id)).rejects.toThrow('lease_lost');
  });
  it('rejects a revoked primary lease while keeping only the old child identity in memory', async () => {
    const fixture = await setup();
    await fixture.service.assertExecutionOwnershipIfPresent(sessionId);
    const current = (await fixture.repository.get(sessionId))!;
    await fixture.repository.releaseLease({ sessionId, fence: { ownerId: current.lease!.ownerId, epoch: current.lease!.epoch } });
    await expect(fixture.service.assertExecutionOwnershipIfPresent(sessionId)).rejects.toThrow('lease_lost');
    expect((await fixture.repository.get(sessionId))!.lease).toBeUndefined();
  });
  it.each(['local_projection', 'unknown_result'] as const)('only a %s WAL may settle the root from verified local child completion', async origin => {
    const f = await setup(), responseId = toConversationResponseExecutionId('verified-local-child-response');
    const prepared = createConversationAgentRun({ id: toConversationAgentRunId('verified-local-child'), parentRunId: sessionId,
      projectId, conversationId, sourceMessageId, createdAt: f.run.createdAt });
    await f.service.admitInitialSegment({ sessionId, run: prepared, inputReference: source });
    await f.service.bindExecution(prepared.id, responseId);
    await f.service.recordSegment({ runId: prepared.id, toolCallsUsed: 1, costUnitsUsed: 8, toolAttemptsUsed: 1 });
    const frozen = await f.service.freeze(sessionId, [toWorkId('verified-local-work')]), at = frozen.updatedAt;
    const child = markConversationAgentRunNeedsReconciliation(attachConversationAgentRunExecution(prepared, responseId, at), 'unknown_result', at);
    const target = confirmConversationAgentRunProjectedCompletion(child, 'completed', at);
    const evaluated = evaluateConversationExecutionCompletion({ run: child, response: { id: responseId, projectId, conversationId, sourceMessageId, state: 'completed' }, unknownResult: true });
    const journal = new JsonConversationCompletionJournal(new NodeProjectStorage(f.root), projectId);
    await journal.save({ schemaVersion: 1, revision: 0, responseExecutionId: responseId, expectedRunRevision: child.revision,
      targetRun: target, decision: { ...evaluated, status: 'completed', executionOwner: 'none', canReplay: false }, responseState: 'completed',
      taskRevisions: [], freezeOrigin: origin, failureStage: 'projection', stage: 'prepared', createdAt: at, updatedAt: at }, null);
    if (origin === 'unknown_result') {
      await expect(f.service.settleVerifiedLocalProjectionAfterChild(target)).rejects.toThrow(/validated projection WAL/);
      expect(await f.repository.get(sessionId)).toEqual(frozen); return;
    }
    const closed = (await f.service.settleVerifiedLocalProjectionAfterChild(target))!;
    expect(closed).toMatchObject({ status: 'closed', closedReason: 'completed', reconciliationAcknowledgement: { source: 'verified_local_projection' } });
    expect(closed.childSegments).toEqual(frozen.childSegments); expect(closed.budget).toEqual(frozen.budget);
    const reopened = f.create('reopened-host');
    expect(await reopened.settleVerifiedLocalProjectionAfterChild(target)).toEqual(closed);
    await expect(f.repository.acquireLease({ sessionId, ownerId: 'never-rerun-projection', ttlMs: 1000 })).rejects.toThrow();
    expect((await reopened.freezeObserved({ sessionId })).status).toBe('closed');
  });
  it('closes an explicitly acknowledged child through its primary WAL without erasing uncertainty or consumption', async () => {
    const f = await setup(), responseId = toConversationResponseExecutionId('ack-child-response');
    const prepared = createConversationAgentRun({ id: toConversationAgentRunId('ack-child'), parentRunId: sessionId,
      projectId, conversationId, sourceMessageId, createdAt: f.run.createdAt });
    await f.service.admitInitialSegment({ sessionId, run: prepared, inputReference: source });
    await f.service.bindExecution(prepared.id, responseId);
    await f.service.recordSegment({ runId: prepared.id, toolCallsUsed: 1, costUnitsUsed: 8, toolAttemptsUsed: 2 });
    const frozen = await f.service.freeze(sessionId, [toWorkId('known-ack-work')]);
    const at = frozen.updatedAt;
    const child = markConversationAgentRunNeedsReconciliation(attachConversationAgentRunExecution(prepared, responseId, at), 'unknown_result', at);
    const target = acknowledgeConversationAgentRunReconciliation(child, at);
    await expect(f.service.acknowledgeReconciliationAfterChild(target)).rejects.toThrow();
    const evaluated = evaluateConversationExecutionCompletion({ run: child, response: { id: responseId, projectId, conversationId,
      sourceMessageId, state: 'interrupted' }, unknownResult: true });
    const journal = new JsonConversationCompletionJournal(new NodeProjectStorage(f.root), projectId);
    await journal.save({ schemaVersion: 1, revision: 0, responseExecutionId: responseId, expectedRunRevision: child.revision,
      targetRun: target, decision: { ...evaluated, status: 'cancelled', executionOwner: 'none', canReplay: false },
      responseState: 'interrupted', taskRevisions: [], stage: 'prepared', createdAt: at, updatedAt: at }, null);
    const closed = (await f.service.acknowledgeReconciliationAfterChild(target))!;
    expect(closed).toMatchObject({ status: 'closed', closedReason: 'cancelled', reconciliationAcknowledgement: { source: 'child_acknowledgement', childRunId: prepared.id } });
    expect(closed.budget).toEqual(frozen.budget); expect(closed.childSegments).toEqual(frozen.childSegments);
    expect(closed.registeredWorkIds).toEqual(frozen.registeredWorkIds); expect(closed.waiting).toBeUndefined(); expect(closed.lease).toBeUndefined();
    expect(await f.service.acknowledgeReconciliationAfterChild(target)).toEqual(closed);
    await expect(f.repository.acquireLease({ sessionId, ownerId: 'never-replay', ttlMs: 1000 })).rejects.toThrow();
  });
  it('requires explicit confirmation and a response-free unknown segment to close a lost planning reply', async () => {
    const f = await setup(); await f.service.markPlanningBoundary(sessionId, 'submitted');
    const frozen = await f.service.freeze(sessionId);
    await expect(f.service.acknowledgeWithoutResponse({ sessionId, expectedRevision: frozen.revision + 1, confirmed: true })).rejects.toThrow();
    const closed = await f.service.acknowledgeWithoutResponse({ sessionId, expectedRevision: frozen.revision, confirmed: true });
    expect(closed).toMatchObject({ status: 'closed', closedReason: 'cancelled', planningBoundary: 'submitted', reconciliationAcknowledgement: { source: 'user_confirmation' } });
    expect(closed.childSegments[0].status).toBe('unknown'); expect(closed.budget).toEqual(frozen.budget);
    const late = await f.service.freezeObserved({ sessionId, registeredWorkIds: [toWorkId('late-confirmed-work')] });
    expect(late.status).toBe('closed'); expect(late.reconciliationAcknowledgement).toEqual(closed.reconciliationAcknowledgement);
    expect(late.registeredWorkIds).toEqual(['late-confirmed-work']);
    expect(() => updateConversationAgentSession(frozen, { status: 'closed', closedReason: 'cancelled', reconciliationAcknowledgement: closed.reconciliationAcknowledgement }, closed.updatedAt)).toThrow(/dedicated/);
    await expect(f.repository.commit({ sessionId, expectedRevision: late.revision, session: { ...late, revision: late.revision + 1,
      reconciliationAcknowledgement: { ...late.reconciliationAcknowledgement!, confirmedAt: toIsoTimestamp(new Date(start + 100).toISOString()) }, updatedAt: toIsoTimestamp(new Date(start + 100).toISOString()) } })).rejects.toThrow(/dedicated/);
  });
  it('uses a stable parent and immutable child response binding across waiting and reply', async () => {
    const fixture = await setup(), waiting = await awaiting(fixture);
    const admitted = await fixture.service.resume(resumeRequest(waiting));
    expect(admitted.session.id).toBe(sessionId); expect(admitted.segment.runId).toBe('session-service-child-1');
    expect(admitted.policy).toEqual(fixture.budget); expect(admitted.session.childSegments[0].status).toBe('settled');
    await fixture.service.bindExecution(admitted.segment.runId, toConversationResponseExecutionId('child-response-1'));
    await expect(fixture.service.bindExecution(admitted.segment.runId, toConversationResponseExecutionId('another-response'))).rejects.toThrow('continuation_invalid');
    expect((await fixture.repository.get(sessionId))!.childSegments[0].responseExecutionId).toBeUndefined();
  });
  it('inherits the original deadline and remaining attempts/units across responses without resetting consumption', async () => {
    const fixture = await setup();
    const run = createConversationAgentRun({ id: toConversationAgentRunId('initial-child'), parentRunId: sessionId, projectId, conversationId, sourceMessageId, createdAt: fixture.run.createdAt });
    await fixture.service.admitInitialSegment({ sessionId, run, inputReference: source });
    await fixture.service.recordSegment({ runId: run.id, toolCallsUsed: 2, costUnitsUsed: 16, toolAttemptsUsed: 3, status: 'settled' });
    fixture.setTime(start + 100);
    const waiting = await awaiting(fixture), admitted = await fixture.service.resume(resumeRequest(waiting));
    expect(admitted.policy).toEqual({ ...fixture.budget, maxToolCalls: 5, budgetUnits: 8 });
    expect(admitted.session.budget).toMatchObject({ startedAt: start, deadlineAt: start + 360_000, toolCallsUsed: 2, costUnitsUsed: 16, toolAttemptsUsed: 3 });
  });
  it('consumes a nonce only once and returns a replay receipt with no new execution policy', async () => {
    const fixture = await setup(), waiting = await awaiting(fixture), request = resumeRequest(waiting);
    const first = await fixture.service.resume(request), replay = await fixture.service.resume({ ...request, childRunId: toConversationAgentRunId('unused-duplicate-child') });
    expect(first.replayed).toBe(false); expect(replay).toMatchObject({ replayed: true, segment: { runId: first.segment.runId } });
    expect(replay.policy).toBeUndefined(); expect(replay.lease).toBeUndefined(); expect(fixture.rechecks).toBe(1);
    expect(replay.session.resumeReceipts).toHaveLength(1); expect(replay.session.childSegments).toHaveLength(2);
    await expect(fixture.service.resume({ ...request, commandId: 'duplicate-click-new-command' })).rejects.toThrow('session_not_waiting');
  });
  it('uses an initial admission once and reads a durable existing segment without dispatch authority', async () => {
    const fixture = await setup(), run = createConversationAgentRun({ id: toConversationAgentRunId('initial-child'), parentRunId: sessionId, projectId, conversationId, sourceMessageId, createdAt: fixture.run.createdAt });
    const first = await fixture.service.admitInitialSegment({ sessionId, run, inputReference: source });
    const repeated = await fixture.service.admitInitialSegment({ sessionId, run, inputReference: source });
    expect(first.replayed).toBe(false); expect(repeated.replayed).toBe(true); expect(repeated.policy).toBeUndefined();
    const repeatedOpen = await fixture.service.open({ run: fixture.run, budget: fixture.budget, inputReferences: [source] });
    expect(repeatedOpen.replayed).toBe(true); expect(repeatedOpen.policy).toBeUndefined();
  });
  it.each([
    { projectId: toProjectId('another-project') }, { conversationId: toConversationId('another-conversation') },
    { expectedRevision: 0 }, { resumeToken: 'wrong-resume-token-that-has-enough-length' }, { action: 'authorize' as const }
  ])('rejects stale or cross-scope authorization without consuming a nonce: %j', async patch => {
    const fixture = await setup(), waiting = await awaiting(fixture);
    await expect(fixture.service.resume(resumeRequest(waiting, patch))).rejects.toThrow();
    const session = (await fixture.repository.get(sessionId))!; expect(session.status).toBe('waiting_user'); expect(session.resumeReceipts).toEqual([]);
  });
  it('rechecks controlled source versions, permissions and model candidates before continuation', async () => {
    const fixture = await setup({ recheck: async input => { expect(input.session.inputReferences).toEqual([source]); throw new Error('permission_revoked'); } });
    const waiting = await awaiting(fixture);
    await expect(fixture.service.resume(resumeRequest(waiting))).rejects.toThrow('permission_revoked');
    expect((await fixture.repository.get(sessionId))!.waiting?.resumeNonceHash).toBe(hash(JSON.stringify(waiting.resumeToken)));
    expect(fixture.rechecks).toBe(1);
  });
  it('rejects continuation after the fixed deadline without extending it', async () => {
    const fixture = await setup(), waiting = await awaiting(fixture);
    fixture.setTime(fixture.budget.deadlineAt);
    await expect(fixture.service.resume(resumeRequest(waiting))).rejects.toThrow('expired');
    expect((await fixture.repository.get(sessionId))!.budget.deadlineAt).toBe(fixture.budget.deadlineAt);
  });
  it('persists an elapsed deadline as expired without acquiring a new execution lease', async () => {
    const fixture = await setup(), waiting = await awaiting(fixture);
    fixture.setTime(fixture.budget.deadlineAt);
    const expired = await fixture.service.expire(sessionId);
    expect(expired).toMatchObject({ status: 'expired', leaseEpoch: 1, budget: { deadlineAt: fixture.budget.deadlineAt } });
    expect(expired.lease).toBeUndefined(); expect(expired.waiting).toBeUndefined();
    await expect(fixture.service.resume(resumeRequest(waiting))).rejects.toThrow('expired');
  });
  it('freezes observed uncertain effects after expiry and keeps known file receipts', async () => {
    const fixture = await setup(); fixture.setTime(fixture.budget.deadlineAt);
    const observed = await fixture.service.freezeObserved({ sessionId, registeredWorkIds: [toWorkId('observed-work')] });
    expect(observed).toMatchObject({ status: 'needs_reconciliation', registeredWorkIds: ['observed-work'] });
    await expect(fixture.service.claimRecovery(sessionId)).rejects.toThrow('unknown_result');
  });
  it('expires its local ownership signal even when lease renewal storage never responds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const fixture = await setup({ overrideRepository: original => {
      const wrapped = Object.create(original) as ConversationAgentSessionRepository;
      wrapped.renewLease = () => new Promise(() => undefined); return wrapped;
    } });
    const signal = (await fixture.service.signalForRun(sessionId))!;
    fixture.setTime(start + 1002); await vi.advanceTimersByTimeAsync(1001);
    expect(signal.aborted).toBe(true); expect((signal.reason as { code: string }).code).toBe('lease_lost');
  });
  it('permanently disables an old recovery token after cancellation', async () => {
    const fixture = await setup(), waiting = await awaiting(fixture);
    await fixture.service.cancel({ sessionId, projectId, conversationId, expectedRevision: waiting.session.revision });
    await expect(fixture.service.resume(resumeRequest(waiting))).rejects.toThrow('closed');
    expect((await fixture.repository.get(sessionId))!.closedReason).toBe('cancelled');
  });
  it('fences the old owner, aborts its signal and preserves independently verified late Work', async () => {
    const fixture = await setup(), oldSignal = (await fixture.service.signalForRun(sessionId))!;
    fixture.setTime(start + 1002);
    const replacement = fixture.create('host-b'); const claim = await replacement.claimRecovery(sessionId);
    expect(claim.lease.epoch).toBe(2);
    await expect(fixture.service.assertExecutionOwnership(sessionId)).rejects.toThrow('lease_lost'); expect(oldSignal.aborted).toBe(true);
    await fixture.service.recordVerifiedWorks(sessionId, [toWorkId('late-known-work')]);
    expect((await fixture.repository.get(sessionId))!.registeredWorkIds).toEqual(['late-known-work']);
    await replacement.assertExecutionOwnership(sessionId);
  });
  it('freezes unknown effects and preserves formal Work receipts without authorizing a new child', async () => {
    const fixture = await setup();
    await fixture.service.recordSegment({ runId: sessionId, toolCallsUsed: 1, costUnitsUsed: 8, toolAttemptsUsed: 1, status: 'unknown', registeredWorkIds: [toWorkId('known-work')] });
    await fixture.service.recordVerifiedWorks(sessionId, [toWorkId('late-work')]);
    await expect(fixture.service.claimRecovery(sessionId)).rejects.toThrow('unknown_result');
    expect((await fixture.repository.get(sessionId))!).toMatchObject({ status: 'needs_reconciliation', registeredWorkIds: ['known-work', 'late-work'], budget: { costUnitsUsed: 8 } });
  });
  it('does not consume a continuation when cancellation arrives while Host rechecks references', async () => {
    const controller = new AbortController(), fixture = await setup({ recheck: async () => { controller.abort(); } }), waiting = await awaiting(fixture);
    await expect(fixture.service.resume(resumeRequest(waiting, { signal: controller.signal }))).rejects.toThrow('cancelled');
    expect((await fixture.repository.get(sessionId))!.resumeReceipts).toEqual([]);
  });
  it('closes an unsubmitted admission when cancellation wins the durable lease claim', async () => {
    const controller = new AbortController(); let repository!: ConversationAgentSessionRepository;
    await expect(setup({ signal: controller.signal, overrideRepository: original => {
      repository = original; const wrapped = Object.create(original) as ConversationAgentSessionRepository;
      wrapped.acquireLease = async input => { const result = await original.acquireLease(input); controller.abort(); return result; }; return wrapped;
    } })).rejects.toThrow('cancelled');
    expect((await repository.get(sessionId))!).toMatchObject({ status: 'closed', closedReason: 'cancelled' });
  });
  it('retains only controlled references and hashes in durable metadata', async () => {
    const fixture = await setup(), waiting = await awaiting(fixture);
    await fixture.service.resume(resumeRequest(waiting));
    const persisted = JSON.stringify(await fixture.repository.get(sessionId));
    expect(persisted).not.toContain(waiting.resumeToken); expect(persisted).not.toContain('apiKey'); expect(persisted).not.toContain(fixture.root);
    expect(persisted).toContain(followup.contentHash);
  });
});
